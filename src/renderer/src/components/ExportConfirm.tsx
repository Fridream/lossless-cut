import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { FaExclamationTriangle, FaInfoCircle, FaRegCheckCircle } from 'react-icons/fa';
import i18n from 'i18next';
import { useTranslation, Trans } from 'react-i18next';
import { IoIosHelpCircle, IoIosSettings } from 'react-icons/io';
import type { SweetAlertIcon } from 'sweetalert2';

import ExportButton from './ExportButton';
import ExportModeButton from './ExportModeButton';
import FileNameTemplateEditor from './FileNameTemplateEditor';
import HighlightedText from './HighlightedText';
import Select from './Select';
import Switch from './Switch';

import { primaryTextColor, warningColor } from '../colors';
import { withBlur } from '../util';
import getSwal from '../swal';
import { isMov as ffmpegIsMov } from '../util/streams';
import useUserSettings from '../hooks/useUserSettings';
import styles from './ExportConfirm.module.css';
import type { SegmentToExport } from '../types';
import type { GenerateOutFileNames } from '../util/outputNameTemplate';
import { defaultCutFileTemplate, defaultCutMergedFileTemplate } from '../util/outputNameTemplate';
import type { FFprobeStream } from '../../../common/ffprobe';
import type { PreserveMetadata, SmartCutPreset } from '../../../common/types';
import TextInput from './TextInput';
import type { UseSegments } from '../hooks/useSegments';
import ExportSheet from './ExportSheet';
import ToggleExportConfirm from './ToggleExportConfirm';
import type { LossyMode } from '../../../main';
import AnimatedTr from './AnimatedTr';


const noticeStyle: CSSProperties = { marginBottom: '.5em' };
const infoStyle: CSSProperties = { ...noticeStyle, color: primaryTextColor };
const warningStyle: CSSProperties = { ...noticeStyle, color: warningColor };

const rightIconStyle: CSSProperties = { fontSize: '1.2em', verticalAlign: 'middle' };

const adjustCutFromValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const adjustCutToValues = [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const HelpIcon = ({ onClick, style }: { onClick: () => void, style?: CSSProperties }) => (
  <IoIosHelpCircle role="button" onClick={withBlur(onClick)} style={{ cursor: 'pointer', color: primaryTextColor, verticalAlign: 'middle', fontSize: '1.5em', ...style }} />
);

function ShiftTimes({ values, num, setNum }: { values: number[], num: number, setNum: (n: number) => void }) {
  const { t } = useTranslation();
  return (
    <Select value={num} onChange={(e) => setNum(Number(e.target.value))} style={{ height: 20, marginLeft: 5 }}>
      {values.map((v) => <option key={v} value={v}>{t('{{numFrames}} frames', { numFrames: v >= 0 ? `+${v}` : v, count: v })}</option>)}
    </Select>
  );
}

function renderNoticeIcon(notice: { warning?: boolean | undefined } | undefined, style?: CSSProperties) {
  if (!notice) return undefined;
  return notice.warning ? (
    <FaExclamationTriangle style={{ flexShrink: '0', fontSize: '.8em', verticalAlign: 'baseline', color: warningColor, ...style }} />
  ) : (
    <FaInfoCircle style={{ flexShrink: '0', fontSize: '.8em', verticalAlign: 'baseline', color: 'var(--blue-10)', ...style }} />
  );
}

function renderNotice(notice: { warning?: boolean | undefined, text: ReactNode } | undefined, { key, style }: { key?: string, style?: CSSProperties }) {
  if (notice == null) return null;
  const { warning, text } = notice;
  return (
    <div key={key} style={{ ...(warning ? warningStyle : infoStyle), gap: '0 .5em', ...style }}>
      {renderNoticeIcon({ warning })} {text}
    </div>
  );
}

function ExportConfirm({
  areWeCutting,
  segmentsToExport,
  willMerge,
  visible,
  onClosePress,
  onExportConfirm,
  outFormat,
  renderOutFmt,
  outputDir,
  numStreamsTotal,
  numStreamsToCopy,
  onShowStreamsSelectorClick,
  cutFileTemplate,
  cutMergedFileTemplate,
  generateCutFileNames,
  generateCutMergedFileNames,
  currentSegIndexSafe,
  segmentsOrInverse,
  mainCopiedThumbnailStreams,
  toggleSettings,
  outputPlaybackRate,
  lossyMode,
  smartCutCrf,
  setSmartCutCrf,
  smartCutPreset,
  setSmartCutPreset,
  forceFixConcat,
  setForceFixConcat,
  exportInfo,
} : {
  areWeCutting: boolean,
  segmentsToExport: SegmentToExport[],
  willMerge: boolean,
  visible: boolean,
  onClosePress: () => void,
  onExportConfirm: () => void,
  outFormat: string | undefined,
  renderOutFmt: (style: CSSProperties) => JSX.Element,
  outputDir: string | undefined,
  numStreamsTotal: number,
  numStreamsToCopy: number,
  onShowStreamsSelectorClick: () => void,
  cutFileTemplate: string,
  cutMergedFileTemplate: string,
  generateCutFileNames: GenerateOutFileNames,
  generateCutMergedFileNames: GenerateOutFileNames,
  currentSegIndexSafe: number,
  segmentsOrInverse: UseSegments['segmentsOrInverse'],
  mainCopiedThumbnailStreams: FFprobeStream[],
  toggleSettings: () => void,
  outputPlaybackRate: number,
  lossyMode: LossyMode | undefined,
  smartCutCrf: number,
  setSmartCutCrf: Dispatch<SetStateAction<number>>,
  smartCutPreset: SmartCutPreset,
  setSmartCutPreset: Dispatch<SetStateAction<SmartCutPreset>>,
  forceFixConcat: boolean,
  setForceFixConcat: Dispatch<SetStateAction<boolean>>,
  exportInfo: { copyCount: number, encodeCount: number, concatCount: number },
}) {
  const { t } = useTranslation();

  const { changeOutDir, preserveMovData, setPreserveMovData, preserveMetadata, setPreserveMetadata, preserveChapters, setPreserveChapters, movFastStart, setMovFastStart, autoDeleteMergedSegments, exportConfirmEnabled, toggleExportConfirmEnabled, segmentsToChapters, setSegmentsToChapters, preserveMetadataOnMerge, setPreserveMetadataOnMerge, effectiveExportMode, enableOverwriteOutput, setEnableOverwriteOutput, ffmpegExperimental, setFfmpegExperimental, cutFromAdjustmentFrames, setCutFromAdjustmentFrames, cutToAdjustmentFrames, setCutToAdjustmentFrames, setCutFileTemplate, setCutMergedFileTemplate, simpleMode } = useUserSettings();

  const [showAdvanced, setShowAdvanced] = useState(!simpleMode);

  const togglePreserveChapters = useCallback(() => setPreserveChapters((val) => !val), [setPreserveChapters]);
  const togglePreserveMovData = useCallback(() => setPreserveMovData((val) => !val), [setPreserveMovData]);
  const toggleMovFastStart = useCallback(() => setMovFastStart((val) => !val), [setMovFastStart]);
  const toggleSegmentsToChapters = useCallback(() => setSegmentsToChapters((v) => !v), [setSegmentsToChapters]);
  const togglePreserveMetadataOnMerge = useCallback(() => setPreserveMetadataOnMerge((v) => !v), [setPreserveMetadataOnMerge]);

  const isMov = ffmpegIsMov(outFormat);
  const isIpod = outFormat === 'ipod';

  // some thumbnail streams (png,jpg etc) cannot always be cut correctly, so we warn if they try to.
  const areWeCuttingProblematicStreams = areWeCutting && mainCopiedThumbnailStreams.length > 0;

  const notices = useMemo(() => {
    const specific: Record<'exportMode' | 'problematicStreams' | 'movFastStart' | 'preserveMovData' | 'overwriteOutput', { warning?: true, text: ReactNode } | undefined> = {
      exportMode: effectiveExportMode === 'segments_to_chapters' ? { text: i18n.t('Segments to chapters mode is active, this means that the file will not be cut. Instead chapters will be created from the segments.') } : undefined,
      problematicStreams: areWeCuttingProblematicStreams ? { warning: true, text: <Trans>Warning: Cutting thumbnail tracks is known to cause problems. Consider disabling track {{ trackNumber: mainCopiedThumbnailStreams[0] ? mainCopiedThumbnailStreams[0].index + 1 : 0 }}.</Trans> } : undefined,
      movFastStart: isMov && isIpod && !movFastStart ? { warning: true, text: t('For the ipod format, it is recommended to activate this option') } : undefined,
      preserveMovData: isMov && isIpod && preserveMovData ? { warning: true, text: t('For the ipod format, it is recommended to deactivate this option') } : undefined,
      overwriteOutput: enableOverwriteOutput ? { text: t('Existing files will be overwritten without warning!') } : undefined,
    };

    const generic: { warning?: true, text: string }[] = [];

    if ((effectiveExportMode === 'separate' || effectiveExportMode === 'merge' || effectiveExportMode === 'merge+separate') && !areWeCutting) {
      generic.push({ text: t('Exporting whole file without cutting, because there are no segments to export.') });
    }

    // https://github.com/mifi/lossless-cut/issues/1809
    if (areWeCutting && outFormat === 'flac') {
      generic.push({ warning: true, text: t('There is a known issue in FFmpeg with cutting FLAC files. The file will be re-encoded, which is still lossless, but the export may be slower.') });
    }
    if (areWeCutting && outputPlaybackRate !== 1) {
      generic.push({ warning: true, text: t('Adjusting the output FPS and cutting at the same time will cause incorrect cuts. Consider instead doing it in two separate steps.') });
    }

    return {
      generic,
      specific,
      totalNum: generic.filter((n) => n.warning).length + Object.values(specific).filter((n) => n != null && n.warning).length,
    };
  }, [areWeCutting, areWeCuttingProblematicStreams, effectiveExportMode, enableOverwriteOutput, isIpod, isMov, mainCopiedThumbnailStreams, movFastStart, outFormat, outputPlaybackRate, preserveMovData, t]);

  const exportModeDescription = useMemo(() => ({
    segments_to_chapters: t('Don\'t cut the file, but instead export an unmodified original which has chapters generated from segments'),
    merge: t('Auto merge segments to one file after export'),
    'merge+separate': t('Auto merge segments into one file after export, but keep exported per-segment files too'),
    separate: t('Export each segment to a separate file'),
  })[effectiveExportMode], [effectiveExportMode, t]);

  const showHelpText = useCallback(({ icon = 'info', timer = 10000, text }: { icon?: SweetAlertIcon, timer?: number, text: string }) => getSwal().toast.fire({ icon, timer, text }), []);

  const onPreserveChaptersPress = useCallback(() => {
    showHelpText({ text: i18n.t('Whether to preserve chapters from source file.') });
  }, [showHelpText]);

  const onPreserveMovDataHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('Preserve all MOV/MP4 metadata tags (e.g. EXIF, GPS position etc.) from source file? Note that some players have trouble playing back files where all metadata is preserved, like iTunes and other Apple software') });
  }, [showHelpText]);

  const onPreserveMetadataHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('Whether to preserve metadata from source file. Default: Global (file metadata), per-track and per-chapter metadata will be copied. Non-global: Only per-track and per-chapter metadata will be copied. None: No metadata will be copied') });
  }, [showHelpText]);

  const onMovFastStartHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('Enabling this will allow faster playback of the exported file. This makes processing use 3 times as much export I/O, which is negligible for small files but might slow down exporting of large files.') });
  }, [showHelpText]);

  const onOutFmtHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('Defaults to same format as input file. You can losslessly change the file format (container) of the file with this option. Not all formats support all codecs. Matroska/MP4/MOV support the most common codecs. Sometimes it\'s even impossible to export to the same output format as input.') });
  }, [showHelpText]);

  const onTracksHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('Not all formats support all track types, and LosslessCut is unable to properly cut some track types, so you may have to sacrifice some tracks by disabling them in order to get correct result.') });
  }, [showHelpText]);

  const onSegmentsToChaptersHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('When merging, do you want to create chapters in the merged file, according to the cut segments? NOTE: This may dramatically increase processing time') });
  }, [showHelpText]);

  const onPreserveMetadataOnMergeHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('When merging, do you want to preserve metadata from your original file? NOTE: This may dramatically increase processing time') });
  }, [showHelpText]);

  const onCutFileTemplateHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('You can customize the file name of the output segment(s) using special variables.', { count: segmentsToExport.length }) });
  }, [segmentsToExport.length, showHelpText]);

  const onCutMergedFileTemplateHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('You can customize the file name of the merged file using special variables.') });
  }, [showHelpText]);

  const onExportModeHelpPress = useCallback(() => {
    showHelpText({ text: exportModeDescription });
  }, [exportModeDescription, showHelpText]);

  const onCutFromAdjustmentFramesHelpPress = useCallback(() => {
    showHelpText({ text: i18n.t('This option allows you to shift all segment start times forward by one or more frames before cutting. This can be useful if the output video starts from the wrong (preceding) keyframe.') });
  }, [showHelpText]);

  const onFfmpegExperimentalHelpPress = useCallback(() => {
    showHelpText({ text: t('Enable experimental ffmpeg features flag?') });
  }, [showHelpText, t]);

  const canEditSegTemplate = !willMerge || !autoDeleteMergedSegments;

  const handleSmartCutCrfChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isNaN(v) || v < 0 || v > 51) return;
    setSmartCutCrf(v);
  }, [setSmartCutCrf]);

  return (
    <ExportSheet
      width="50em"
      visible={visible}
      title={t('Export options')}
      onClosePress={onClosePress}
      renderButton={() => (
        <ExportButton segmentsToExport={segmentsToExport} areWeCutting={areWeCutting} onClick={withBlur(() => onExportConfirm())} style={{ fontSize: '1.3em' }} />
      )}
      renderBottom={() => (
        <>
          <ToggleExportConfirm size="1.5em" />
          <div style={{ fontSize: '.8em', marginLeft: '.4em', marginRight: '.5em', maxWidth: '8.5em', lineHeight: '100%', color: exportConfirmEnabled ? 'var(--gray-12)' : 'var(--gray-11)', cursor: 'pointer' }} role="button" onClick={toggleExportConfirmEnabled}>
            {t('Show this page before exporting?')}
          </div>
          {notices.totalNum > 0 && (
            renderNoticeIcon({ warning: true }, { fontSize: '1.5em', marginRight: '.5em' })
          )}
        </>
      )}
    >
      <table className={styles['options']}>
        <tbody>
          <tr>
            <td colSpan={2}>
              {notices.generic.map(({ warning, text }) => (
                renderNotice({ warning, text }, { key: text })
              ))}
            </td>
            <td />
          </tr>

          {segmentsOrInverse.selected.length !== segmentsOrInverse.all.length && (
            <tr>
              <td colSpan={2}>
                <FaRegCheckCircle size={12} style={{ marginRight: 3 }} />{t('{{selectedSegments}} of {{nonFilteredSegments}} segments selected', { selectedSegments: segmentsOrInverse.selected.length, nonFilteredSegments: segmentsOrInverse.all.length })}
              </td>
              <td />
            </tr>
          )}

          <tr>
            <td>
              {segmentsOrInverse.selected.length > 1 ? t('Export mode for {{segments}} segments', { segments: segmentsOrInverse.selected.length }) : t('Export mode')}
              {renderNotice(notices.specific['exportMode'], { style: { fontSize: '85%' } })}
            </td>
            <td>
              <ExportModeButton selectedSegments={segmentsOrInverse.selected} style={{ height: '1.8em' }} />
            </td>
            <td>
              {renderNoticeIcon(notices.specific['exportMode'], rightIconStyle) ?? <HelpIcon onClick={onExportModeHelpPress} />}
            </td>
          </tr>

          <tr>
            <td>
              {t('Output container format:')}
            </td>
            <td>
              {renderOutFmt({ height: '1.8em', maxWidth: 150 })}
            </td>
            <td>
              <HelpIcon onClick={onOutFmtHelpPress} />
            </td>
          </tr>

          <tr>
            <td>
              <Trans>Input has {{ numStreamsTotal }} tracks</Trans>
              {renderNotice(notices.specific['problematicStreams'], { style: { fontSize: '85%' } })}
            </td>
            <td>
              <HighlightedText style={{ cursor: 'pointer' }} onClick={onShowStreamsSelectorClick}><Trans>Keeping {{ numStreamsToCopy }} tracks</Trans></HighlightedText>
            </td>
            <td>
              {renderNoticeIcon(notices.specific['problematicStreams'], rightIconStyle) ?? <HelpIcon onClick={onTracksHelpPress} />}
            </td>
          </tr>

          <tr>
            <td>
              {t('Save output to path:')}
            </td>
            <td>
              <HighlightedText role="button" onClick={changeOutDir} style={{ wordBreak: 'break-all', cursor: 'pointer' }}>{outputDir}</HighlightedText>
            </td>
            <td />
          </tr>

          {canEditSegTemplate && (
            <tr>
              <td colSpan={2}>
                <FileNameTemplateEditor mode="separate" template={cutFileTemplate} setTemplate={setCutFileTemplate} defaultTemplate={defaultCutFileTemplate} generateFileNames={generateCutFileNames} currentSegIndexSafe={currentSegIndexSafe} />
              </td>
              <td>
                <HelpIcon onClick={onCutFileTemplateHelpPress} />
              </td>
            </tr>
          )}

          {willMerge && (
            <tr>
              <td colSpan={2}>
                <FileNameTemplateEditor mode="merge-segments" template={cutMergedFileTemplate} setTemplate={setCutMergedFileTemplate} defaultTemplate={defaultCutMergedFileTemplate} generateFileNames={generateCutMergedFileNames} />
              </td>
              <td>
                <HelpIcon onClick={onCutMergedFileTemplateHelpPress} />
              </td>
            </tr>
          )}

          <tr>
            <td>
              {t('Overwrite existing files')}
              {renderNotice(notices.specific['overwriteOutput'], { style: { fontSize: '85%' } })}
            </td>
            <td>
              <Switch checked={enableOverwriteOutput} onCheckedChange={setEnableOverwriteOutput} />
            </td>
            <td>
              {renderNoticeIcon(notices.specific['overwriteOutput'], rightIconStyle) ?? <HelpIcon onClick={() => showHelpText({ text: t('Overwrite files when exporting, if a file with the same name as the output file name exists?') })} />}
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ marginBottom: '.5em' }}>{t('Advanced options')}</h3>

      <table className={styles['options']}>
        <tbody>
          <tr>
            <td style={{ paddingTop: '.5em', color: 'var(--gray-11)', fontSize: '.9em' }} colSpan={2}>
              {t('Depending on your specific file/player, you may have to try different options for best results.')}
            </td>
            <td />
          </tr>

          <tr>
            <td>
              {t('Show advanced options')}
            </td>
            <td>
              <Switch checked={showAdvanced} onCheckedChange={setShowAdvanced} />
            </td>
            <td />
          </tr>

          {showAdvanced && (
            <>
              {areWeCutting && (
                <>
                  <AnimatedTr>
                    <td>
                      {t('Shift all start times')}
                    </td>
                    <td>
                      <ShiftTimes values={adjustCutFromValues} num={cutFromAdjustmentFrames} setNum={setCutFromAdjustmentFrames} />
                    </td>
                    <td>
                      <HelpIcon onClick={onCutFromAdjustmentFramesHelpPress} />
                    </td>
                  </AnimatedTr>
                  <AnimatedTr>
                    <td>
                      {t('Shift all end times')}
                    </td>
                    <td>
                      <ShiftTimes values={adjustCutToValues} num={cutToAdjustmentFrames} setNum={setCutToAdjustmentFrames} />
                    </td>
                    <td />
                  </AnimatedTr>
                </>
              )}

              {isMov && (
                <>
                  <AnimatedTr>
                    <td>
                      {t('Enable MOV Faststart?')}
                    </td>
                    <td>
                      <Switch checked={movFastStart} onCheckedChange={toggleMovFastStart} />
                      {renderNotice(notices.specific['movFastStart'], { style: { fontSize: '85%' } })}
                    </td>
                    <td>
                      {renderNoticeIcon(notices.specific['movFastStart'], rightIconStyle) ?? <HelpIcon onClick={onMovFastStartHelpPress} />}
                    </td>
                  </AnimatedTr>

                  <AnimatedTr>
                    <td>
                      {t('Preserve all MP4/MOV metadata?')}
                      {renderNotice(notices.specific['preserveMovData'], { style: { fontSize: '85%' } })}
                    </td>
                    <td>
                      <Switch checked={preserveMovData} onCheckedChange={togglePreserveMovData} />
                    </td>
                    <td>
                      {renderNoticeIcon(notices.specific['preserveMovData'], rightIconStyle) ?? <HelpIcon onClick={onPreserveMovDataHelpPress} />}
                    </td>
                  </AnimatedTr>
                </>
              )}

              <AnimatedTr>
                <td>
                  {t('Preserve chapters')}
                </td>
                <td>
                  <Switch checked={preserveChapters} onCheckedChange={togglePreserveChapters} />
                </td>
                <td>
                  <HelpIcon onClick={onPreserveChaptersPress} />
                </td>
              </AnimatedTr>

              <AnimatedTr>
                <td>
                  {t('Preserve metadata')}
                </td>
                <td>
                  <Select value={preserveMetadata} onChange={(e) => setPreserveMetadata(e.target.value as PreserveMetadata)} style={{ height: 20, marginLeft: 5 }}>
                    <option value={'default' satisfies PreserveMetadata}>{t('Default')}</option>
                    <option value={'none' satisfies PreserveMetadata}>{t('None')}</option>
                    <option value={'nonglobal' satisfies PreserveMetadata}>{t('Non-global')}</option>
                  </Select>
                </td>
                <td>
                  <HelpIcon onClick={onPreserveMetadataHelpPress} />
                </td>
              </AnimatedTr>

              {willMerge && (
                <>
                  <AnimatedTr>
                    <td>
                      {t('Create chapters from merged segments? (slow)')}
                    </td>
                    <td>
                      <Switch checked={segmentsToChapters} onCheckedChange={toggleSegmentsToChapters} />
                    </td>
                    <td>
                      <HelpIcon onClick={onSegmentsToChaptersHelpPress} />
                    </td>
                  </AnimatedTr>

                  <AnimatedTr>
                    <td>
                      {t('Preserve original metadata when merging? (slow)')}
                    </td>
                    <td>
                      <Switch checked={preserveMetadataOnMerge} onCheckedChange={togglePreserveMetadataOnMerge} />
                    </td>
                    <td>
                      <HelpIcon onClick={onPreserveMetadataOnMergeHelpPress} />
                    </td>
                  </AnimatedTr>
                </>
              )}

              {exportInfo.encodeCount > 0 && (
                <>
                  <AnimatedTr>
                    <td>
                      {t('Smart cut quality (CRF)')}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                        <TextInput value={smartCutCrf} onChange={handleSmartCutCrfChange} style={{ width: '4em', flexGrow: 0, marginRight: '.3em' }} />
                      </div>
                    </td>
                    <td />
                  </AnimatedTr>

                  <AnimatedTr>
                    <td>
                      {t('Smart cut encoding speed')}
                    </td>
                    <td>
                      <Select value={smartCutPreset} onChange={(e) => setSmartCutPreset(e.target.value as SmartCutPreset)} style={{ height: 20, marginLeft: 5 }}>
                        <option value="veryslow">veryslow</option>
                        <option value="slower">slower</option>
                        <option value="slow">slow</option>
                        <option value="medium">medium</option>
                      </Select>
                    </td>
                    <td />
                  </AnimatedTr>
                </>
              )}

              {exportInfo.concatCount > 0 && (
                <AnimatedTr>
                  <td>
                    {t('Force fix concat error')}
                  </td>
                  <td>
                    <Switch checked={forceFixConcat} onCheckedChange={() => setForceFixConcat((v) => !v)} />
                  </td>
                  <td />
                </AnimatedTr>
              )}

              {lossyMode != null && (
                <AnimatedTr>
                  <td>
                    {t('Lossy mode')}
                  </td>
                  <td>
                    <Switch disabled checked={lossyMode != null} />
                    <div>{lossyMode.videoEncoder}</div>
                  </td>
                  <td />
                </AnimatedTr>
              )}

              <AnimatedTr>
                <td>
                  {t('"ffmpeg" experimental flag')}
                </td>
                <td>
                  <Switch checked={ffmpegExperimental} onCheckedChange={setFfmpegExperimental} />
                </td>
                <td>
                  <HelpIcon onClick={onFfmpegExperimentalHelpPress} />
                </td>
              </AnimatedTr>

              <AnimatedTr>
                <td>
                  {t('More settings')}
                </td>
                <td>
                  <IoIosSettings size={24} role="button" onClick={toggleSettings} style={{ marginLeft: 5 }} />
                </td>
                <td />
              </AnimatedTr>

              <AnimatedTr>
                <td>
                  {`预计 复制 ${exportInfo.copyCount} 次，重编码 ${exportInfo.encodeCount} 次，合并 ${exportInfo.concatCount} 次`}
                </td>
                <td />
                <td />
              </AnimatedTr>
            </>
          )}
        </tbody>
      </table>
    </ExportSheet>
  );
}

export default memo(ExportConfirm);
