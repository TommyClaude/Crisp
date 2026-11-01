import SwiftUI

struct TipsView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Where cameras hide") {
                    bullet("Smoke detectors and air purifiers — especially one right above the bed.")
                    bullet("Alarm clocks, radios and TV set-top boxes facing the bed.")
                    bullet("USB chargers, power adapters and power strips left plugged in.")
                    bullet("Routers or unfamiliar boxes with more LEDs than usual.")
                    bullet("Picture frames, wall décor, plants and tissue boxes.")
                    bullet("Air vents, screw heads and small dark holes pointing at the bed or shower.")
                }

                Section("Quick manual checks") {
                    bullet("Darken the room and sweep it with the IR Scan tab — night-vision LEDs glow on camera.")
                    bullet("Shine your flashlight slowly across suspicious objects and look for a tiny glint reflected straight back: that's how lenses behave.")
                    bullet("Unplug what you can. A clock or charger that fights to stay plugged in near the bed deserves a close look.")
                    bullet("Mirror check: press a fingertip against the mirror. A visible gap between finger and reflection is normal glass. No gap can mean an observation mirror — ask the hotel about any mirror that seems built into the wall oddly.")
                    bullet("Feel for warmth. Hidden electronics running all day are often warm to the touch.")
                }

                Section("If you find something") {
                    bullet("Don't touch or unplug it — it may be evidence.")
                    bullet("Cover the lens with a towel and move your belongings out of its view.")
                    bullet("Photograph it and where it is in the room.")
                    bullet("Ask the front desk for a different room, and report it to the local police.")
                }

                Section("Honest limits") {
                    Text("No app can guarantee a room is free of hidden cameras. CamSweep helps you spot the common, cheap devices; a wired camera with no IR, no network and a well-hidden lens can evade every check here. Combine the tools, trust your instincts, and escalate to professionals if you're seriously concerned.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Tips")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
            Text(text)
        }
        .font(.subheadline)
    }
}

#Preview {
    TipsView()
}
