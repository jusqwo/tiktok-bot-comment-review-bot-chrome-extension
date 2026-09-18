// On-device speech-to-text with Apple's SpeechAnalyzer (macOS 26+). No network, no API key.
// Built on first use by server.mjs:  swiftc -O -parse-as-library transcribe.swift -o .bin/transcribe
// Usage: transcribe <audio-file> [language, e.g. "en" or "es-MX"]
// Prints one JSON line: {"text": "...", "locale": "en_US", "seconds": 49.1}
// Exit codes: 1 = error, 2 = language not supported on this Mac.
import AVFoundation
import Foundation
import Speech

@main
struct Transcribe {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 2 else { exit(fail("usage: transcribe <audio-file> [language]", 1)) }
    let wanted = Locale(identifier: args.count > 2 && !args[2].isEmpty ? args[2] : "en-US")
    do {
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
      let seconds = Double(file.length) / file.processingFormat.sampleRate
      if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) {
        let module = SpeechTranscriber(locale: locale, preset: .transcription)
        let text = try await run(module, file: file) { results in
          var out = ""
          for try await r in results { out += String(r.text.characters) }
          return out
        } results: { module.results }
        return emit(text, locale, seconds)
      }
      if let locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted) {
        let module = DictationTranscriber(locale: locale, preset: .longDictation)
        let text = try await run(module, file: file) { results in
          var out = ""
          for try await r in results { out += String(r.text.characters) }
          return out
        } results: { module.results }
        return emit(text, locale, seconds)
      }
      exit(fail("language '\(wanted.identifier)' is not supported by on-device transcription", 2))
    } catch {
      exit(fail("\(error)", 1))
    }
  }

  static func run<M: SpeechModule, S: AsyncSequence>(
    _ module: M, file: AVAudioFile,
    collect: @escaping (S) async throws -> String,
    results: () -> S
  ) async throws -> String {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
      try await request.downloadAndInstall()  // one-time model download for this language
    }
    let analyzer = SpeechAnalyzer(modules: [module])
    let sequence = results()
    let collector = Task { try await collect(sequence) }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collector.value
  }

  static func emit(_ text: String, _ locale: Locale, _ seconds: Double) {
    let obj: [String: Any] = ["text": text.trimmingCharacters(in: .whitespacesAndNewlines), "locale": locale.identifier, "seconds": seconds]
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
  }

  static func fail(_ message: String, _ code: Int32) -> Int32 {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    return code
  }
}
