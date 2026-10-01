import SwiftUI

/// The app's colour and type tokens, in one place.
///
/// Colours are written in OKLCH and converted at runtime, so the palette stays perceptually
/// even: a "30% grey" here is the same lightness as a 30% grey anywhere else, which is why the
/// three tier colours read as equally bright instead of one shouting over the others.
///
/// The anchor hue is amber (70). Every neutral carries a trace of it, so the greys lean warm and
/// sit with the accent instead of fighting it. Dark-only by intent: this lives in the menu bar
/// next to a dark menu strip, and a light panel there reads as a bug.
enum Theme {
    // MARK: - Surfaces
    /// The panel background. Not pure black: a trace of chroma keeps it from looking like a hole.
    static let paper = Color(oklch: 0.145, 0.008, 70)
    static let surface = Color(oklch: 0.185, 0.010, 70)
    static let surfaceHi = Color(oklch: 0.225, 0.011, 70)
    static let rule = Color(oklch: 0.285, 0.010, 70)

    // MARK: - Ink
    static let ink = Color(oklch: 0.965, 0.006, 80)
    static let inkSoft = Color(oklch: 0.800, 0.008, 78)
    static let muted = Color(oklch: 0.655, 0.010, 75)
    static let faint = Color(oklch: 0.500, 0.010, 72)

    // MARK: - Accent
    /// One accent, used for the live/running state and the primary action. Roughly 3% of the
    /// panel; it is a highlighter, never a fill.
    static let accent = Color(oklch: 0.720, 0.165, 62)
    static let focus = Color(oklch: 0.760, 0.150, 68)

    // MARK: - Tiers
    /// Cheap-to-capable, so the ramp runs cool → warm. Each one is also named and carries a
    /// glyph in the UI, because colour alone would fail anyone who cannot separate them.
    static let haiku = Color(oklch: 0.760, 0.110, 196)
    static let sonnet = Color(oklch: 0.790, 0.130, 92)
    static let opus = Color(oklch: 0.700, 0.170, 38)
    static let fable = Color(oklch: 0.720, 0.150, 320)

    static func tier(_ name: String?) -> Color {
        switch name {
        case "haiku": haiku
        case "sonnet": sonnet
        case "opus": opus
        case "fable": fable
        default: muted
        }
    }

    /// What each tier is, in the user's words rather than marketing words.
    static func blurb(_ name: String) -> String {
        switch name {
        case "haiku": "Lookups, edits, small answers"
        case "sonnet": "Ordinary coding"
        case "opus": "Hard work, design, open-ended"
        case "fable": "Longest runs, extra credits"
        default: ""
        }
    }

    static func label(_ name: String) -> String {
        switch name {
        case "haiku": "Haiku"
        case "sonnet": "Sonnet"
        case "opus": "Opus"
        case "fable": "Fable"
        default: name.capitalized
        }
    }

    /// One glyph per tier. The dot alone would be colour-only signalling.
    static func glyph(_ name: String) -> String {
        switch name {
        case "haiku": "bolt.fill"
        case "sonnet": "gearshape.2.fill"
        case "opus": "brain.head.profile.fill"
        case "fable": "sparkles"
        default: "circle"
        }
    }

    // MARK: - Type
    /// SF Pro carries optical sizing and a tracking table, so the ramp below is tuned rather
    /// than guessed: tight and heavy as size grows, loose and light as it shrinks. Mono is used
    /// only for figures, where digit alignment is the whole point.
    enum Face {
        static let hero = SwiftUI.Font.system(size: 30, weight: .semibold)
        static let title = SwiftUI.Font.system(size: 15, weight: .semibold)
        static let body = SwiftUI.Font.system(size: 13, weight: .regular)
        static let label = SwiftUI.Font.system(size: 11, weight: .medium)
        static let micro = SwiftUI.Font.system(size: 10, weight: .medium)
        static let figure = SwiftUI.Font.system(size: 13, weight: .medium).monospacedDigit()
        static let figureBig = SwiftUI.Font.system(size: 30, weight: .semibold).monospacedDigit()
    }

    // MARK: - Metrics
    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 22
        static let panel: CGFloat = 14
    }
}

extension Color {
    /// Builds a colour from OKLCH, which is where the palette is specified. `alpha` is a
    /// modifier, never the definition of a colour.
    ///
    /// The conversion is the real one: OKLCH → OKLab → linear sRGB → sRGB, with the out-of-gamut
    /// result desaturated toward grey rather than wrapped to a different hue. (Passing only the
    /// lightness to `calibratedWhite` would flatten every accent to a grey, which is exactly the
    /// kind of bug that looks like "the theme is wrong" rather than "the maths is wrong".)
    init(oklch: Double, _ chroma: Double, _ hue: Double, alpha: Double = 1) {
        let h = hue * .pi / 180
        let a = chroma * cos(h)
        let b = chroma * sin(h)
        let l_ = oklch + 0.3963377774 * a + 0.2158037573 * b
        let m_ = oklch - 0.1055613458 * a - 0.0638541728 * b
        let s_ = oklch - 0.0894841775 * a - 1.2914855480 * b
        let l = l_ * l_ * l_
        let m = m_ * m_ * m_
        let s = s_ * s_ * s_
        let rgb = (
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        )
        // Any negative channel means the colour is outside sRGB. Pull the chroma back until it
        // fits, so the hue survives and only the saturation gives way.
        let fitted = Self.fitToGamut(oklch, chroma, hue, rgb)
        self.init(
            .sRGB,
            red: Self.gamma(fitted.0), green: Self.gamma(fitted.1), blue: Self.gamma(fitted.2),
            opacity: alpha
        )
    }

    private static func fitToGamut(_ l: Double, _ c: Double, _ h: Double, _ rgb: (Double, Double, Double)) -> (Double, Double, Double) {
        func linear(_ v: Double) -> Bool { v >= -1e-4 && v <= 1.0001 }
        if linear(rgb.0) && linear(rgb.1) && linear(rgb.2) { return rgb }
        // Bisect on chroma: 12 steps is well past what the eye can see at 8-bit.
        var lo = 0.0, hi = c
        for _ in 0..<12 {
            let mid = (lo + hi) / 2
            let rad = h * .pi / 180
            let a = mid * cos(rad)
            let b = mid * sin(rad)
            let l_ = l + 0.3963377774 * a + 0.2158037573 * b
            let m_ = l - 0.1055613458 * a - 0.0638541728 * b
            let s_ = l - 0.0894841775 * a - 1.2914855480 * b
            let L = l_ * l_ * l_
            let M = m_ * m_ * m_
            let S = s_ * s_ * s_
            let test = (
                4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
                -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
                -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S
            )
            if linear(test.0) && linear(test.1) && linear(test.2) { lo = mid } else { hi = mid }
        }
        let rad = h * .pi / 180
        let a = lo * cos(rad)
        let b = lo * sin(rad)
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b
        let L = l_ * l_ * l_
        let M = m_ * m_ * m_
        let S = s_ * s_ * s_
        return (
            4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
            -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
            -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S
        )
    }

    /// Linear light → sRGB, the piecewise transfer function rather than a plain 1/2.2, which
    /// would wash out the midtones the whole palette sits in.
    private static func gamma(_ v: Double) -> Double {
        let c = min(1, max(0, v))
        return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
    }
}
