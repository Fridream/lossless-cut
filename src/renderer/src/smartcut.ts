import { getRealVideoStreams, getVideoTimebase } from './util/streams';

import { readFramesAroundTime, readKeyframesAroundTime, isIDRFrame } from './ffmpeg';
import type { FFprobeStream } from '../../common/ffprobe';
import { readFileSize } from './util';


const mapVideoCodec = (codec: string) => ({ av1: 'libsvtav1' }[codec] ?? codec);

export async function needsSmartCut({ path, exactCutFrom, exactCutTo, fileDuration, videoStream }: {
  path: string,
  exactCutFrom: number,
  exactCutTo: number,
  fileDuration: number | undefined,
  videoStream: Pick<FFprobeStream, 'index' | 'codec_name'>,
}) {
  let losslessCutFrom; // 有值时表示需要头smart cut，作为头编码的尾点，中/尾复制的起点
  let losslessCutTo; // 无值时表示需要整段重编码，有值时作为头/中复制的尾点
  let losslessCutToPTS; // 有值时表示需要尾smart cut，作为尾编码的起点
  const readFrames = async (aroundTime: number, window: number) => readFramesAroundTime({ filePath: path, streamIndex: videoStream.index, aroundTime, window });
  const readKeyframes = async (aroundTime: number, window: number) => readKeyframesAroundTime({ filePath: path, streamIndex: videoStream.index, aroundTime, window });
  const checkKeyframe = async (PTSTime: number) => isIDRFrame({ filePath: path, streamIndex: videoStream.index, PTSTime, codecName: videoStream.codec_name });

  // 在最近10s内所有帧里找与切头时间最近的帧，如果是关键帧即头部不用切，否则用之后的且最近的关键帧
  let frames = await readFrames(exactCutFrom, 10); let keyFrames; let selectedFrame; let keyFrame;
  for (const frame of frames) { if (frame.time === exactCutFrom) selectedFrame = frame; if (frame.keyframe && frame.time >= exactCutFrom && await checkKeyframe(frame.time)) { keyFrame = frame; break; } }
  if (keyFrame && keyFrame === selectedFrame) console.log('Start cut is already on exact keyframe', selectedFrame.time, selectedFrame);
  else {
    if (!keyFrame) { keyFrames = await readKeyframes(exactCutFrom, 60); for (const key of keyFrames) if (key.time > exactCutFrom && await checkKeyframe(key.time)) { keyFrame = key; break; } }
    // 找不到下一个关键帧时或者切尾在下一个关键帧前时直接整段重编码
    if (!keyFrame || keyFrame.time >= exactCutTo) return { losslessCutFrom, losslessCutTo, losslessCutToPTS };
    console.log('Smart cut from keyframe', { keyframe: keyFrame.time, exactCutFrom });
    losslessCutFrom = keyFrame.time;
  }

  if (fileDuration === exactCutTo) return { losslessCutFrom, losslessCutTo: fileDuration, losslessCutToPTS };
  // 在附近3s找安全点，使得最后得包含的那一帧DTS时间小于最前不应该包含的那一帧DTS时间，以此作为DTS实际切割尾点
  // 找不到安全点时直接整段重编码，正常情况下10帧内必有安全点
  const copyHead = losslessCutFrom ?? exactCutFrom; frames = await readFrames(exactCutTo, 3); selectedFrame = undefined;
  for (const frame of frames) if (frame.time === exactCutTo) { selectedFrame = frame; break; }
  for (const frame of frames.filter((f) => f.time <= selectedFrame!.time && f.time > copyHead).sort((a, b) => b.time - a.time)) {
    const minDtsAfterFrame = frames.filter((f) => f.time >= frame.time).reduce((min, f) => (f.DTSTime < min.DTSTime ? f : min));
    const maxDtsBeforeFrame = frames.filter((f) => f.time < frame.time).reduce((max, f) => (f.DTSTime > max.DTSTime ? f : max));
    const minDtsAfter = minDtsAfterFrame.DTSTime; const maxDtsBefore = maxDtsBeforeFrame.DTSTime;
    if (maxDtsBefore < minDtsAfter) { losslessCutTo = minDtsAfter; if (frame !== selectedFrame) losslessCutToPTS = frame.time; break; }
  }
  return { losslessCutFrom, losslessCutTo, losslessCutToPTS };
}

// eslint-disable-next-line import/prefer-default-export
export async function getCodecParams({ path, fileDuration, streams }: {
  path: string,
  fileDuration: number | undefined,
  streams: Pick<FFprobeStream, 'has_b_frames' | 'time_base' | 'codec_type' | 'disposition' | 'index' | 'bit_rate' | 'codec_name'>[],
}) {
  const videoStreams = getRealVideoStreams(streams);
  if (videoStreams.length > 1) throw new Error('Can only smart cut video with exactly one video stream');

  const [videoStream] = videoStreams;

  if (videoStream == null) throw new Error('Smart cut only works on videos');

  let videoBitrate = parseInt(videoStream.bit_rate!, 10);
  if (Number.isNaN(videoBitrate)) {
    console.warn('Unable to detect input bitrate.');
    const size = await readFileSize(path);
    if (fileDuration == null) throw new Error('Video duration is unknown, cannot estimate bitrate');
    videoBitrate = (size * 8) / fileDuration;
    console.warn('Estimated bitrate.', videoBitrate / 1e6, 'Mbit/s');
  }

  // to account for inaccuracies and quality loss
  // see discussion https://github.com/mifi/lossless-cut/issues/126#issuecomment-1602266688
  videoBitrate = Math.floor(videoBitrate * 1.2);

  const { codec_name: detectedVideoCodec } = videoStream;
  if (detectedVideoCodec == null) throw new Error('Unable to determine codec for smart cut');

  const videoCodec = mapVideoCodec(detectedVideoCodec);
  console.log({ detectedVideoCodec, videoCodec });

  const timebase = getVideoTimebase(videoStream);
  if (timebase == null) console.warn('Unable to determine timebase', videoStream.time_base);

  // seems like ffmpeg handles this itself well when encoding same source file
  // const videoLevel = parseLevel(videoStream);
  // const videoProfile = parseProfile(videoStream);

  return {
    videoStream,
    videoCodec,
    videoBitrate: Math.floor(videoBitrate),
    videoTimebase: timebase,
  };
}
