import type { CSSProperties } from 'react';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
const TOOLBAR_GAP = 8;

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

// ─── Helper: compute new selection ────────────────────────────────────────────

function calcNewSelection(focused: FocusTarget, original: CropArea, dx: number, dy: number) {
  let { x, y, w, h } = original;
  if (focused === 'box') { // MOVE
    x = Math.max(0, Math.min(1 - w, x + dx));
    y = Math.max(0, Math.min(1 - h, y + dy));
  } else { // RESIZE
    if (focused === 'tl' || focused === 'ml' || focused === 'bl') {
      x = Math.max(0, Math.min(original.x + original.w - MIN_SIZE, original.x + dx));
      w = original.x + original.w - x;
    }
    if (focused === 'tr' || focused === 'mr' || focused === 'br') {
      w = Math.max(MIN_SIZE, Math.min(1 - original.x, original.w + dx));
    }
    if (focused === 'tl' || focused === 'tc' || focused === 'tr') {
      y = Math.max(0, Math.min(original.y + original.h - MIN_SIZE, original.y + dy));
      h = original.y + original.h - y;
    }
    if (focused === 'bl' || focused === 'bc' || focused === 'br') {
      h = Math.max(MIN_SIZE, Math.min(1 - original.y, original.h + dy));
    }
  }
  return { x, y, w, h };
}

// ─── Helper: compute display rect from DOM ────────────────────────────────────

function calcDisplayRect(cr: DOMRect, video: HTMLVideoElement) {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw || !vh) return null;

  const ca = cr.width / cr.height;
  const va = vw / vh;

  let dw; let dh; let ox; let oy;
  if (ca > va) {
    dh = cr.height;
    dw = dh * va;
    ox = (cr.width - dw) / 2;
    oy = 0;
  } else {
    dw = cr.width;
    dh = dw / va;
    oy = (cr.height - dh) / 2;
    ox = 0;
  }
  return { dw, dh, ox, oy };
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface CropSelectorHandle { handleKeyDown: (e: KeyboardEvent) => boolean; }

function CropSelector({ onCropComplete, videoRef, initialCrop }: {
  onCropComplete: (cropArea: CropArea | null) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
  initialCrop: CropArea | null;
}, ref: React.Ref<CropSelectorHandle>) {
  const [phase, setPhase] = useState<Phase>(initialCrop ? 'selected' : 'idle');
  const [selection, setSelection] = useState<CropArea | null>(initialCrop);
  const [displayRect, setDisplayRect] = useState<DisplayRect | null>(null);
  const [overlayScreenRect, setOverlayScreenRect] = useState<DOMRect | null>(null);

  // focus: which element has keyboard focus ('box' | handle key | null)
  const [focused, setFocused] = useState<FocusTarget | null>(null);
  // hoveredBorder: which border side the pointer is over (for hint styling)
  const [hoveredBorder, setHoveredBorder] = useState<BorderSide | null>(null);
  // hoveredHandle: which handle the pointer is over (for hint styling)
  const [hoveredHandle, setHoveredHandle] = useState<ResizeHandle | null>(null);
  // toolbar visibility: shown when mouse is inside the box, auto-hides 3s after leaving
  const [toolbarVisible, setToolbarVisible] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const displayRectRef = useRef<DisplayRect | null>(null);
  const focusedRef = useRef<FocusTarget | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync with state
  useEffect(() => { displayRectRef.current = displayRect; }, [displayRect]);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  // ── Sync displayRect & containerHeight via ResizeObserver ─────────────────

  const refreshDisplayRect = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!overlay || !video) return;
    const overlayRect = overlay.getBoundingClientRect();
    setOverlayScreenRect(overlayRect);
    setDisplayRect(calcDisplayRect(overlayRect, video));
  }, [videoRef]);

  useEffect(() => {
    const el = overlayRef.current;
    refreshDisplayRect();
    const ro = new ResizeObserver(() => refreshDisplayRect());
    ro.observe(el!);
    return () => ro.disconnect();
  }, [refreshDisplayRect]);

  // ── toRel ──────────────────────────────────────────────────────────────────
  // Uses a ref so it never goes stale inside document-level handlers.

  const toRel = useCallback((clientX: number, clientY: number) => {
    const overlay = overlayRef.current;
    const dr = displayRectRef.current;
    if (!overlay || !dr) return null;
    const cr = overlay.getBoundingClientRect();
    return {
      x: (clientX - cr.left - dr.ox) / dr.dw,
      y: (clientY - cr.top - dr.oy) / dr.dh,
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

  // ── Tool bar: auto hide tool bar ───────────────────────────────────────────

  const showToolbar = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setToolbarVisible(true);
  }, []);

  const hideToolbar = useCallback(({ immediate = false } = {}) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (immediate) setToolbarVisible(false);
    else hideTimerRef.current = setTimeout(() => setToolbarVisible(false), 1500);
  }, []);

  // ── Draw (overlay mousedown) ───────────────────────────────────────────────

  const onOverlayMouseDown = useCallback((e: React.MouseEvent) => {
    // Clicked on the overlay outside the selection box → clear focus
    if (phase === 'selected') { setFocused(null); return; }

    e.preventDefault(); e.stopPropagation();
    const startPos = toRel(e.clientX, e.clientY);
    if (!startPos) return;

    startPos.x = Math.max(0, Math.min(1, startPos.x));
    startPos.y = Math.max(0, Math.min(1, startPos.y));

    setPhase('drawing');
    setSelection({ x: startPos.x, y: startPos.y, w: 0, h: 0 });

    const onDocMove = (ev: MouseEvent) => {
      const cur = toRel(ev.clientX, ev.clientY);
      if (!cur) return;
      cur.x = Math.max(0, Math.min(1, cur.x));
      cur.y = Math.max(0, Math.min(1, cur.y));
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
      cur.x = Math.max(0, Math.min(1, cur.x));
      cur.y = Math.max(0, Math.min(1, cur.y));

      const w = Math.abs(cur.x - startPos.x);
      const h = Math.abs(cur.y - startPos.y);
      if (w < MIN_SIZE || h < MIN_SIZE) { setPhase('idle'); setSelection(null); return; }

      setSelection({ x: Math.min(startPos.x, cur.x), y: Math.min(startPos.y, cur.y), w, h });
      setPhase('selected');
      showToolbar();
    };

    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
  }, [phase, toRel, showToolbar]);

  // ── Move (click/drag box interior) ─────────────────────────────────────────

  const startMove = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!selection) return;
    setFocused('box');

    const startPos = toRel(e.clientX, e.clientY);
    if (!startPos) return;
    const s = { ...selection };

    const onMove = (ev: MouseEvent) => {
      const pos = toRel(ev.clientX, ev.clientY);
      if (!pos) return;
      const dx = pos.x - startPos.x;
      const dy = pos.y - startPos.y;
      setSelection(calcNewSelection('box', s, dx, dy));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [selection, toRel]);

  // ── Resize (handle mousedown) ──────────────────────────────────────────────

  const startResize = useCallback((e: React.MouseEvent, handle: ResizeHandle) => {
    e.preventDefault(); e.stopPropagation();
    if (!selection) return;
    setFocused(handle);

    const startPos = toRel(e.clientX, e.clientY);
    if (!startPos) return;
    const s = { ...selection };

    const onMove = (ev: MouseEvent) => {
      const pos = toRel(ev.clientX, ev.clientY);
      if (!pos) return;
      const dx = pos.x - startPos.x;
      const dy = pos.y - startPos.y;
      setSelection(calcNewSelection(handle, s, dx, dy));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [selection, toRel]);

  useImperativeHandle(ref, () => ({ handleKeyDown: (e: KeyboardEvent) => {
    const target = focusedRef.current;
    if (!target) return false;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return false;

    const dr = displayRectRef.current;
    if (!dr) return false;
    const stepX = 1 / dr.dw;
    const stepY = 1 / dr.dh;

    let dx = 0; let dy = 0;
    switch (e.key) {
      case 'ArrowLeft': { dx = -stepX; break; }
      case 'ArrowRight': { dx = stepX; break; }
      case 'ArrowUp': { dy = -stepY; break; }
      case 'ArrowDown': { dy = stepY; break; }
    }
    setSelection((prev) => calcNewSelection(target, prev!, dx, dy));
    return true;
  } }), []);

  // ── Confirm / Cancel ───────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    (cancel: boolean) => onCropComplete(cancel ? null : selection),
    [selection, onCropComplete],
  );

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
            role="presentation"
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
            }}
            onMouseDown={phase === 'selected' ? startMove : undefined}
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
                      onMouseLeave={() => setHoveredBorder(null)}
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
                      onMouseLeave={() => setHoveredHandle(null)}
                      onMouseDown={(e) => startResize(e, h)}
                    />
                  );
                })}
              </>
            )}
          </div>

          {/* ── Confirm / Cancel toolbar (portal → escapes overflow:hidden) ── */}
          {phase === 'selected' && px && (() => {
            const overlayRect = overlayScreenRect;
            if (!overlayRect) return null;
            const screenRight = overlayRect.left + px.left + px.width;
            const screenBottom = overlayRect.top + px.top + px.height + TOOLBAR_GAP;
            return createPortal(
              <div
                role="presentation"
                style={{
                  position: 'fixed',
                  left: screenRight,
                  transform: 'translateX(-100%)',
                  top: screenBottom,
                  display: 'flex',
                  gap: 6,
                  zIndex: 9999,
                  pointerEvents: 'none',
                }}
              >
                <button
                  type="button"
                  onClick={() => handleSubmit(false)}
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
                    pointerEvents: 'auto',
                  }}
                >
                  ✓ 确认
                </button>
                <button
                  type="button"
                  onClick={() => handleSubmit(true)}
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
                    pointerEvents: 'auto',
                  }}
                >
                  ✕ 取消
                </button>
              </div>,
              document.body,
            );
          })()}
        </>
      )}
    </div>
  );
}

export default memo(
  forwardRef<CropSelectorHandle, Parameters<typeof CropSelector>[0]>(CropSelector),
);
