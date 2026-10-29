import Foundation

final class MobileWebShellAssetRead {
  private let lock = NSLock()
  private var completion: ((Data?) -> Void)?

  init(completion: @escaping (Data?) -> Void) {
    self.completion = completion
  }

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return completion != nil
  }

  func cancel() {
    lock.lock()
    let completion = self.completion
    self.completion = nil
    lock.unlock()
    withExtendedLifetime(completion) {}
  }

  func read(
    _ file: URL,
    using load: (URL) throws -> Data = { try Data(contentsOf: $0) }
  ) -> Data? {
    guard isActive else { return nil }
    let data = try? load(file)
    return isActive ? data : nil
  }

  // Main-thread completion serializes delivery with WebKit's stop callback.
  func complete(_ data: Data?) {
    lock.lock()
    let completion = self.completion
    self.completion = nil
    lock.unlock()
    completion?(data)
  }
}
