import type { CSSProperties } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CropArea } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'drawing' | 'selected';
type ResizeHandle = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';
type FocusTarget = 'box' | ResizeHandle;
type BorderSide = 'top' | 'right' | 'bottom' | 'left';

interface DisplayRect {
  dw: number;
  dh: number;
  ox: number;
  oy: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_SIZE = 0.02;
const HANDLE_PX = 8;
const BORDER_HIT = 12; // hit-area thickness for border edges (px)

// ─── Handle configs ───────────────────────────────────────────────────────────

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  tl: 'nwse-resize',
  tc: 'ns-resize',
  tr: 'nesw-resize',
  ml: 'ew-resize',
  mr: 'ew-resize',
  bl: 'nesw-resize',
  bc: 'ns-resize',
  br: 'nwse-resize',
};

const half = HANDLE_PX / 2;

const HANDLE_POSITIONS: Record<ResizeHandle, CSSProperties> = {
  tl: { top: -half, left: -half },
  tc: { top: -half, left: '50%', transform: 'translateX(-50%)' },
  tr: { top: -half, right: -half },
  ml: { top: '50%', left: -half, transform: 'translateY(-50%)' },
  mr: { top: '50%', right: -half, transform: 'translateY(-50%)' },
  bl: { bottom: -half, left: -half },
  bc: { bottom: -half, left: '50%', transform: 'translateX(-50%)' },
  br: { bottom: -half, right: -half },
};

const ALL_HANDLES: ResizeHandle[] = ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'];

// Border side → its corresponding mid handle
const BORDER_TO_HANDLE: Record<BorderSide, ResizeHandle> = {
  top: 'tc',
  right: 'mr',
  bottom: 'bc',
  left: 'ml',
};

// Mid handles that correspond to a border side (used for hint logic)
const MID_HANDLES = new Set<ResizeHandle>(['tc', 'ml', 'mr', 'bc']);

function handleToBorderSide(h: ResizeHandle): BorderSide | null {
  for (const [side, handle] of Object.entries(BORDER_TO_HANDLE) as [BorderSide, ResizeHandle][]) {
    if (handle === h) return side;
  }
  return null;
}

// ─── Style helpers ────────────────────────────────────────────────────────────

function getHandleStyle(h: ResizeHandle, isFocused: boolean, isHinted: boolean): CSSProperties {
  return {
    position: 'absolute',
    width: HANDLE_PX,
    height: HANDLE_PX,
    backgroundColor: isFocused ? '#60a5fa' : (isHinted ? '#93c5fd' : '#fff'),
    border: '1px solid rgba(0,0,0,0.4)',
    borderRadius: 1,
    cursor: HANDLE_CURSORS[h],
    zIndex: 2,
    transition: 'background-color 0.12s',
    ...HANDLE_POSITIONS[h],
  };
}

// ─── Keyboard delta ───────────────────────────────────────────────────────────
//
// Returns { dx, dy, dw, dh } in relative coords for a given focused target + key.
// stepX / stepY = 1px expressed as a fraction of the display rect dimension.

function getKeyboardDelta(
  focused: FocusTarget,
  key: string,
  stepX: number,
  stepY: number,
): { dx: number; dy: number; dw: number; dh: number } | null {
  const d = { dx: 0, dy: 0, dw: 0, dh: 0 };

  // ── Whole-box move ──────────────────────────────────────────────────────────
  if (focused === 'box') {
    switch (key) {
      case 'ArrowLeft': { d.dx = -stepX; break; }
      case 'ArrowRight': { d.dx = stepX; break; }
      case 'ArrowUp': { d.dy = -stepY; break; }
      case 'ArrowDown': { d.dy = stepY; break; }
      default: { return null; }
    }
    return d;
  }

  // ── Handle resize ───────────────────────────────────────────────────────────
  // Determine which edges this handle controls
  const isLeft = focused === 'tl' || focused === 'ml' || focused === 'bl';
  const isRight = focused === 'tr' || focused === 'mr' || focused === 'br';
  const isTop = focused === 'tl' || focused === 'tc' || focused === 'tr';
  const isBottom = focused === 'bl' || focused === 'bc' || focused === 'br';

  let handled = false;

  switch (key) {
    case 'ArrowLeft': {
      if (isLeft) { d.dx = -stepX; d.dw = stepX; handled = true; } // pull left edge left
      if (isRight) { d.dw = -stepX; handled = true; } // pull right edge left
      break;
    }
    case 'ArrowRight': {
      if (isLeft) { d.dx = stepX; d.dw = -stepX; handled = true; } // push left edge right
      if (isRight) { d.dw = stepX; handled = true; } // push right edge right
      break;
    }
    case 'ArrowUp': {
      if (isTop) { d.dy = -stepY; d.dh = stepY; handled = true; } // pull top edge up
      if (isBottom) { d.dh = -stepY; handled = true; } // pull bottom edge up
      break;
    }
    case 'ArrowDown': {
      if (isTop) { d.dy = stepY; d.dh = -stepY; handled = true; } // push top edge down
      if (isBottom) { d.dh = stepY; handled = true; } // push bottom edge down
      break;
    }
  }

  return handled ? d : null;
}

// ─── Helper: compute display rect from DOM ────────────────────────────────────

function computeDisplayRect(
  overlay: HTMLDivElement,
  video: HTMLVideoElement,
): DisplayRect | null {
  const cr = overlay.getBoundingClientRect();
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw || !vh) return null;

  const ca = cr.width / cr.height;
  const va = vw / vh;
  let dw: number;
  let dh: number;
  let ox: number;
  let oy: number;

  if (ca > va) {
    dh = cr.height;
    dw = dh * va;
    ox = (cr.width - dw) / 2;
    oy = 0;
  } else {
    dw = cr.width;
    dh = dw / va;
    ox = 0;
    oy = (cr.height - dh) / 2;
  }

  return { dw, dh, ox, oy };
}

// ─── Component ────────────────────────────────────────────────────────────────

function CropSelector({
  onCropComplete,
  videoRef,
}: {
  onCropComplete: (cropArea: CropArea) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [selection, setSelection] = useState<CropArea | null>(null);
  const [displayRect, setDisplayRect] = useState<DisplayRect | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  // focus: which element has keyboard focus ('box' | handle key | null)
  const [focused, setFocused] = useState<FocusTarget | null>(null);
  // hoveredBorder: which border side the pointer is over (for hint styling)
  const [hoveredBorder, setHoveredBorder] = useState<BorderSide | null>(null);
  // hoveredHandle: which handle the pointer is over (for hint styling)
  const [hoveredHandle, setHoveredHandle] = useState<ResizeHandle | null>(null);
  // toolbar visibility: shown when mouse is inside the box, auto-hides 3s after leaving
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  // Refs for values needed inside document-level event listeners
  const displayRectRef = useRef<DisplayRect | null>(null);
  const focusedRef = useRef<FocusTarget | null>(null);

  // Keep refs in sync with state
  useEffect(() => { displayRectRef.current = displayRect; }, [displayRect]);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  // ── Sync displayRect & containerHeight via ResizeObserver ─────────────────

  const refreshDisplayRect = useCallback(() => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!overlay || !video) return;
    setContainerHeight(overlay.getBoundingClientRect().height);
    const dr = computeDisplayRect(overlay, video);
    setDisplayRect(dr);
    displayRectRef.current = dr;
  }, [videoRef]);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return undefined;
    refreshDisplayRect();
    const ro = new ResizeObserver(() => refreshDisplayRect());
    ro.observe(el);
    return () => ro.disconnect();
  }, [refreshDisplayRect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.addEventListener('loadedmetadata', refreshDisplayRect);
    return () => video.removeEventListener('loadedmetadata', refreshDisplayRect);
  }, [videoRef, refreshDisplayRect]);

  // ── toRel ──────────────────────────────────────────────────────────────────
  // Uses a ref so it never goes stale inside document-level handlers.

  const toRel = useCallback((clientX: number, clientY: number) => {
    const overlay = overlayRef.current;
    const dr = displayRectRef.current;
    if (!overlay || !dr) return null;
    const cr = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - cr.left - dr.ox) / dr.dw)),
      y: Math.max(0, Math.min(1, (clientY - cr.top - dr.oy) / dr.dh)),
    };
  }, []);

  // ── px: pixel geometry for rendering ──────────────────────────────────────

  const px = useMemo(() => {
    if (!selection || !displayRect) return null;
    return {
      left: displayRect.ox + selection.x * displayRect.dw,
      top: displayRect.oy + selection.y * displayRect.dh,
      width: selection.w * displayRect.dw,
      height: selection.h * displayRect.dh,
    };
  }, [selection, displayRect]);

  const toolbarAbove = px ? px.top + px.height + 40 > containerHeight : false;

  // ── Keyboard handler ───────────────────────────────────────────────────────
  // Attached as onKeyDown on the focusable selection box div, so the event
  // never reaches the video player — no capture-phase hacks needed.

  const onSelectionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocused(null);
        return;
      }

      const currentFocused = focusedRef.current;
      if (!currentFocused) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;

      const dr = displayRectRef.current;
      if (!dr) return;
      e.preventDefault();

      const stepX = 1 / dr.dw;
      const stepY = 1 / dr.dh;
      const delta = getKeyboardDelta(currentFocused, e.key, stepX, stepY);
      if (!delta) return;

      setSelection((prev) => {
        if (!prev) return prev;
        const w = Math.max(MIN_SIZE, Math.min(1, prev.w + delta.dw));
        const h = Math.max(MIN_SIZE, Math.min(1, prev.h + delta.dh));
        const x = Math.max(0, Math.min(1 - w, prev.x + delta.dx));
        const y = Math.max(0, Math.min(1 - h, prev.y + delta.dy));
        return { x, y, w, h };
      });
    },
    [],
  );

  // ── Draw (overlay mousedown) ───────────────────────────────────────────────

  const showToolbar = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setToolbarVisible(true);
  }, []);

  const hideToolbar = useCallback(({ immediate = false } = {}) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (immediate) setToolbarVisible(false);
    else hideTimerRef.current = setTimeout(() => setToolbarVisible(false), 1500);
  }, []);

  const onOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (phase === 'selected') {
        // Clicked on the overlay outside the selection box → clear focus
        setFocused(null);
        return;
      }

      e.preventDefault();
      const startPos = toRel(e.clientX, e.clientY);
      if (!startPos) return;

      setPhase('drawing');
      setFocused(null);
      setSelection({ x: startPos.x, y: startPos.y, w: 0, h: 0 });

      const onDocMove = (ev: MouseEvent) => {
        const cur = toRel(ev.clientX, ev.clientY);
        if (!cur) return;
        setSelection({
          x: Math.min(startPos.x, cur.x),
          y: Math.min(startPos.y, cur.y),
          w: Math.abs(cur.x - startPos.x),
          h: Math.abs(cur.y - startPos.y),
        });
      };

      const onDocUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onDocMove);
        document.removeEventListener('mouseup', onDocUp);

        const cur = toRel(ev.clientX, ev.clientY);
        if (!cur) { setPhase('idle'); setSelection(null); return; }

        const w = Math.abs(cur.x - startPos.x);
        const h = Math.abs(cur.y - startPos.y);
        if (w < MIN_SIZE || h < MIN_SIZE) { setPhase('idle'); setSelection(null); return; }

        setSelection({ x: Math.min(startPos.x, cur.x), y: Math.min(startPos.y, cur.y), w, h });
        setPhase('selected');
        // do NOT auto-focus after drawing
        setFocused(null);
        showToolbar();
      };

      document.addEventListener('mousemove', onDocMove);
      document.addEventListener('mouseup', onDocUp);
    },
    [phase, toRel, showToolbar],
  );

  // ── Move (click/drag box interior) ─────────────────────────────────────────

  const startMove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selection) return;

      // clicking box interior focuses the box
      setFocused('box');
      selectionBoxRef.current?.focus();

      const startPos = toRel(e.clientX, e.clientY);
      if (!startPos) return;
      const startSel = { ...selection };

      const onMove = (ev: MouseEvent) => {
        const pos = toRel(ev.clientX, ev.clientY);
        if (!pos) return;
        setSelection({
          x: Math.max(0, Math.min(1 - startSel.w, startSel.x + pos.x - startPos.x)),
          y: Math.max(0, Math.min(1 - startSel.h, startSel.y + pos.y - startPos.y)),
          w: startSel.w,
          h: startSel.h,
        });
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        selectionBoxRef.current?.focus();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [selection, toRel],
  );

  // ── Resize (handle mousedown) ──────────────────────────────────────────────

  const startResize = useCallback(
    (e: React.MouseEvent, handle: ResizeHandle) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selection) return;

      // focus the clicked handle
      setFocused(handle);
      selectionBoxRef.current?.focus();

      const startPos = toRel(e.clientX, e.clientY);
      if (!startPos) return;
      const s = { ...selection };

      const onMove = (ev: MouseEvent) => {
        const pos = toRel(ev.clientX, ev.clientY);
        if (!pos) return;
        const dx = pos.x - startPos.x;
        const dy = pos.y - startPos.y;
        let { x, y, w, h } = s;

        if (handle === 'tl' || handle === 'ml' || handle === 'bl') {
          const nx = Math.max(0, Math.min(s.x + s.w - MIN_SIZE, s.x + dx));
          w = s.x + s.w - nx;
          x = nx;
        }
        if (handle === 'tr' || handle === 'mr' || handle === 'br') {
          w = Math.max(MIN_SIZE, Math.min(1 - s.x, s.w + dx));
        }
        if (handle === 'tl' || handle === 'tc' || handle === 'tr') {
          const ny = Math.max(0, Math.min(s.y + s.h - MIN_SIZE, s.y + dy));
          h = s.y + s.h - ny;
          y = ny;
        }
        if (handle === 'bl' || handle === 'bc' || handle === 'br') {
          h = Math.max(MIN_SIZE, Math.min(1 - s.y, s.h + dy));
        }

        setSelection({ x, y, w, h });
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        selectionBoxRef.current?.focus();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [selection, toRel],
  );

  // ── Confirm / Cancel ───────────────────────────────────────────────────────

  const handleConfirm = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (selection) onCropComplete(selection);
    },
    [selection, onCropComplete],
  );

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    hideToolbar({ immediate: true });
    setPhase('idle');
    setSelection(null);
    setFocused(null);
    setHoveredBorder(null);
    setHoveredHandle(null);
  }, [hideToolbar]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        cursor: phase === 'selected' ? 'default' : 'crosshair',
        zIndex: 10,
      }}
      onMouseDown={onOverlayMouseDown}
      role="presentation"
    >
      {px && (
        <>
          {/* ── Selection box ────────────────────────────────────────────── */}
          <div
            ref={selectionBoxRef}
            role="presentation"
            tabIndex={-1}
            style={{
              position: 'absolute',
              left: px.left,
              top: px.top,
              width: px.width,
              height: px.height,
              border: 'none',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
              boxSizing: 'border-box',
              pointerEvents: phase === 'selected' ? 'auto' : 'none',
              cursor: 'move',
              zIndex: 11,
              outline: 'none',
            }}
            onMouseDown={phase === 'selected' ? startMove : undefined}
            onKeyDown={phase === 'selected' ? onSelectionKeyDown : undefined}
            onMouseEnter={phase === 'selected' ? showToolbar : undefined}
            onMouseLeave={phase === 'selected' ? () => hideToolbar() : undefined}
          >
            {phase === 'selected' && (
              <>
                {/* ── Border hit areas (4 edges) ─────────────────────────── */}
                {/*
                  - Click → focus the corresponding mid-handle (via startResize)
                  - Hover → hint the corresponding mid-handle
                  Hit areas are slightly inset from the corners so they don't
                  overlap the corner handles.
                */}
                {(['top', 'right', 'bottom', 'left'] as BorderSide[]).map((side) => {
                  const correspondingHandle = BORDER_TO_HANDLE[side];
                  const isH = side === 'top' || side === 'bottom';
                  const cornerGap = half;

                  const edgeGeometry = (() => {
                    switch (side) {
                      case 'top': { return { top: -BORDER_HIT / 2, left: cornerGap, right: cornerGap, height: BORDER_HIT }; }
                      case 'bottom': { return { bottom: -BORDER_HIT / 2, left: cornerGap, right: cornerGap, height: BORDER_HIT }; }
                      case 'left': { return { left: -BORDER_HIT / 2, top: cornerGap, bottom: cornerGap, width: BORDER_HIT }; }
                      default: { return { right: -BORDER_HIT / 2, top: cornerGap, bottom: cornerGap, width: BORDER_HIT }; }
                    }
                  })();

                  const sideStyle: CSSProperties = {
                    position: 'absolute',
                    cursor: isH ? 'ns-resize' : 'ew-resize',
                    zIndex: 1,
                    ...edgeGeometry,
                  };

                  return (
                    <div
                      key={side}
                      role="presentation"
                      style={sideStyle}
                      onMouseEnter={() => { showToolbar(); setHoveredBorder(side); }}
                      onMouseLeave={() => { hideToolbar(); setHoveredBorder(null); }}
                      onMouseDown={(e) => startResize(e, correspondingHandle)}
                    />
                  );
                })}

                {/* ── Resize handles (8 corners + mids) ─────────────────── */}
                {ALL_HANDLES.map((h) => {
                  const isFocused = focused === h;
                  const isHandleHovered = hoveredHandle === h;
                  const borderSide = MID_HANDLES.has(h) ? handleToBorderSide(h) : null;
                  const isBorderHinted = borderSide !== null && hoveredBorder === borderSide;
                  const isHinted = isHandleHovered || isBorderHinted;

                  return (
                    <div
                      key={h}
                      role="presentation"
                      style={{
                        ...getHandleStyle(h, isFocused, isHinted),
                        opacity: toolbarVisible ? 1 : 0,
                        transition: 'opacity 0.2s',
                      }}
                      onMouseEnter={() => { showToolbar(); setHoveredHandle(h); }}
                      onMouseLeave={() => { hideToolbar(); setHoveredHandle(null); }}
                      onMouseDown={(e) => startResize(e, h)}
                    />
                  );
                })}
              </>
            )}
          </div>

          {/* ── Confirm / Cancel toolbar ───────────────────────────────────── */}
          {phase === 'selected' && (
            <div
              role="presentation"
              style={{
                position: 'absolute',
                left: px.left + px.width,
                transform: 'translateX(-100%)',
                top: toolbarAbove ? px.top - 40 : px.top + px.height + 8,
                display: 'flex',
                gap: 6,
                zIndex: 12,
                pointerEvents: 'auto',
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={handleConfirm}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#fff',
                  background: 'rgba(37, 99, 235, 0.75)',
                  border: '1px solid rgba(99, 155, 255, 0.5)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.3px',
                  width: 64,
                  justifyContent: 'center',
                }}
              >
                ✓ 确认
              </button>
              <button
                type="button"
                onClick={handleCancel}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.85)',
                  background: 'rgba(255,255,255,0.12)',
                  border: '1px solid rgba(255,255,255,0.25)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.3px',
                  width: 64,
                  justifyContent: 'center',
                }}
              >
                ✕ 取消
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(CropSelector);
