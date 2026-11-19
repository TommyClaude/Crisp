import Foundation

/// Sample-data mode, used for screenshots. Launching the app with
/// `-demoScreen <name>` opens that screen directly and fills it with sample
/// data instead of live sensor readings.
enum Demo {
    static let screen: String? = UserDefaults.standard.string(forKey: "demoScreen")
    static var isOn: Bool { screen != nil }
}
