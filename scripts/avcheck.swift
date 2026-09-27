// Decodes exported MP4s with AVFoundation — the stack QuickTime, Photos and
// Safari <video> use — so a file that plays in ffmpeg-based players but not
// on Apple's (or the reverse) can't slip through. Per file: asset
// playable/readable, then EVERY video frame decoded (count, first/last pts,
// reader status) and the audio track decoded to float PCM (samples, RMS).
// Used by the `exportquality` bench runs (docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md);
// the MP4s land in bench/exports/.
//
//   swiftc -O -o /tmp/avcheck scripts/avcheck.swift
//   /tmp/avcheck bench/exports/*.mp4
//
// One line per file, `key=value` pairs; exit status 1 if any file failed to decode.
import AVFoundation

var failures = 0

func decodeVideo(_ asset: AVURLAsset, _ track: AVAssetTrack) -> String {
  do {
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ])
    out.alwaysCopiesSampleData = false
    reader.add(out)
    guard reader.startReading() else {
      failures += 1
      return "video=startReading-failed err=\(reader.error.map { "\($0)" } ?? "?")"
    }
    var frames = 0
    var first = -1.0
    var last = -1.0
    while let sb = out.copyNextSampleBuffer() {
      guard CMSampleBufferGetImageBuffer(sb) != nil else { continue }
      let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
      if frames == 0 { first = pts }
      last = pts
      frames += 1
    }
    if reader.status != .completed { failures += 1 }
    let size = track.naturalSize
    return "video=\(Int(size.width))x\(Int(size.height)) fps=\(String(format: "%.2f", track.nominalFrameRate)) " +
      "kbps=\(Int(track.estimatedDataRate / 1000)) frames=\(frames) " +
      "pts=\(String(format: "%.3f", first))..\(String(format: "%.3f", last)) " +
      "status=\(reader.status.rawValue) err=\(reader.error.map { "\($0)" } ?? "none")"
  } catch {
    failures += 1
    return "video=reader-init-failed err=\(error)"
  }
}

func decodeAudio(_ asset: AVURLAsset, _ track: AVAssetTrack) -> String {
  let fmt = track.formatDescriptions.first as! CMFormatDescription
  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
  do {
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
    ])
    reader.add(out)
    guard reader.startReading() else {
      failures += 1
      return "audio=startReading-failed err=\(reader.error.map { "\($0)" } ?? "?")"
    }
    var samples = 0
    var sumSq = 0.0
    while let sb = out.copyNextSampleBuffer() {
      guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
      var len = 0
      var ptr: UnsafeMutablePointer<Int8>?
      CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
      let n = len / 4
      ptr!.withMemoryRebound(to: Float.self, capacity: n) { f in
        for i in 0..<n { sumSq += Double(f[i] * f[i]) }
      }
      samples += n
    }
    if reader.status != .completed || samples == 0 { failures += 1 }
    let rms = samples > 0 ? 10 * log10(sumSq / Double(samples) + 1e-20) : -999
    return "audio sr=\(Int(asbd?.mSampleRate ?? 0)) ch=\(asbd?.mChannelsPerFrame ?? 0) samples=\(samples) " +
      "rmsDb=\(String(format: "%.1f", rms)) status=\(reader.status.rawValue) err=\(reader.error.map { "\($0)" } ?? "none")"
  } catch {
    failures += 1
    return "audio=reader-init-failed err=\(error)"
  }
}

for path in CommandLine.arguments.dropFirst() {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  var parts = ["\((path as NSString).lastPathComponent): playable=\(asset.isPlayable) readable=\(asset.isReadable)"]
  if let v = asset.tracks(withMediaType: .video).first { parts.append(decodeVideo(asset, v)) } else {
    failures += 1
    parts.append("video=none")
  }
  if let a = asset.tracks(withMediaType: .audio).first { parts.append(decodeAudio(asset, a)) } else {
    parts.append("audio=none")
  }
  print(parts.joined(separator: " | "))
}
exit(failures > 0 ? 1 : 0)
