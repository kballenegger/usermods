#if os(macOS)
import AppKit
import SafariServices

/// The one screen the host app has on macOS. The iOS version is App/ViewController.swift.
///
/// Same job as on iOS: a Safari web extension is not installable on its own, so it ships inside an
/// app, and the app answers the question someone has right after opening it. The Mac can do one
/// thing iOS cannot, and it is the reason this is a separate screen rather than a shared one:
/// `SFSafariApplication.showPreferencesForExtension` opens Safari on the extension's own row, so the
/// first step is a button instead of a sentence about where to click.
///
/// The colours are the BBS Underground tokens from docs/branding.md, spelled out here because a
/// native screen cannot read the extension's CSS.
final class MacViewController: NSViewController {
    private enum Brand {
        /// --brand-ink
        static let ink = NSColor(srgbRed: 0x03 / 255, green: 0x0B / 255, blue: 0x16 / 255, alpha: 1)
        /// --brand-lime
        static let lime = NSColor(srgbRed: 0xAE / 255, green: 0xFF / 255, blue: 0x24 / 255, alpha: 1)
        static let text = NSColor(white: 0.92, alpha: 1)
        static let dim = NSColor(white: 0.62, alpha: 1)
        /// The error red from docs/design.md, which the palette has on purpose: the magenta accent
        /// cannot be told apart from it under tritanopia, so failures get a colour and a word.
        static let error = NSColor(srgbRed: 0xFF / 255, green: 0x6B / 255, blue: 0x6B / 255, alpha: 1)
    }

    /// The extension's bundle identifier, derived rather than hardcoded so a build with
    /// `USERMODS_BUNDLE_ID` overridden still opens its own row and not the public build's.
    private var extensionBundleIdentifier: String {
        let app = Bundle.main.bundleIdentifier ?? "io.github.kballenegger.usermods"
        return "\(app).extension"
    }

    /// Only shown when opening Safari's settings fails, which is the one thing on this screen that
    /// can. Silence there would look identical to Safari ignoring the click.
    private lazy var failure: NSTextField = {
        let label = note("")
        label.textColor = Brand.error
        label.isHidden = true
        return label
    }()

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = Brand.ink.cgColor
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let stack = NSStackView()
        stack.orientation = .vertical
        // Leading rather than .width so the button keeps its natural size. Everything that should
        // run the full width is added through fill(), below.
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false

        func fill(_ subview: NSView) {
            stack.addArrangedSubview(subview)
            subview.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        fill(heading("usermods"))
        fill(
            body(
                "Customise any website by chatting with a model. The extension lives in Safari, "
                    + "not in this app, so there is one switch to flip before it appears."
            )
        )
        stack.addArrangedSubview(openSettingsButton())
        fill(failure)
        fill(rule())
        fill(
            step(1, "Keep this app somewhere it will stay, such as the Applications folder. Safari "
                + "finds the extension inside this bundle, so moving or deleting the app takes the "
                + "extension with it.")
        )
        fill(
            step(2, "Turn usermods on in Safari, Settings, Extensions. The button above opens that "
                + "list on its row.")
        )
        fill(
            step(3, "Next to it, set Always Allow on Every Website. A userscript manager cannot "
                + "work one click at a time.")
        )
        fill(step(4, "Click usermods in the Safari toolbar."))
        fill(rule())
        fill(
            note(
                "Add a model provider API key in Settings inside the extension before you chat. A "
                    + "model running on this Mac is reachable at localhost, which is not true of the "
                    + "iPhone and iPad builds."
            )
        )
        fill(
            note(
                "Built it yourself and the list is empty? A build signed only to run locally is "
                    + "unsigned as far as Safari is concerned, and Safari hides those until it is "
                    + "told to allow them: turn on Show features for web developers in Safari, "
                    + "Settings, Advanced, then allow unsigned extensions in the Develop menu. That "
                    + "allowance is a Safari-wide developer setting and it resets when Safari quits."
            )
        )

        let clip = NSView()
        clip.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(stack)

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = clip
        view.addSubview(scroll)

        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            clip.widthAnchor.constraint(equalTo: scroll.widthAnchor),
            stack.topAnchor.constraint(equalTo: clip.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: clip.bottomAnchor, constant: -28),
            stack.leadingAnchor.constraint(equalTo: clip.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -24),
        ])
    }

    @objc private func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) {
            [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.failure.stringValue =
                    "Safari did not open its extension settings: \(error.localizedDescription) "
                    + "Open Safari, then Settings, then Extensions by hand."
                self?.failure.isHidden = false
            }
        }
    }

    private func openSettingsButton() -> NSButton {
        let button = NSButton(
            title: "Open Safari extension settings",
            target: self,
            action: #selector(openSafariSettings)
        )
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.keyEquivalent = "\r"
        return button
    }

    private func heading(_ text: String) -> NSTextField {
        let label = label(text)
        label.textColor = Brand.lime
        label.font = .monospacedSystemFont(ofSize: 32, weight: .bold)
        return label
    }

    private func body(_ text: String) -> NSTextField {
        let label = label(text)
        label.textColor = Brand.text
        label.font = .preferredFont(forTextStyle: .body)
        return label
    }

    private func note(_ text: String) -> NSTextField {
        let label = label(text)
        label.textColor = Brand.dim
        label.font = .preferredFont(forTextStyle: .footnote)
        return label
    }

    private func step(_ number: Int, _ text: String) -> NSView {
        let index = label("\(number)")
        index.textColor = Brand.ink
        index.alignment = .center
        index.font = .monospacedSystemFont(ofSize: 13, weight: .bold)

        // The lime square is a layer on a container rather than the text field's own
        // backgroundColor: an NSTextField draws its background in the cell, below the layer, so a
        // corner radius on the field itself rounds nothing.
        let chip = NSView()
        chip.translatesAutoresizingMaskIntoConstraints = false
        chip.wantsLayer = true
        chip.layer?.backgroundColor = Brand.lime.cgColor
        chip.layer?.cornerRadius = 4
        chip.addSubview(index)
        NSLayoutConstraint.activate([
            chip.widthAnchor.constraint(equalToConstant: 24),
            chip.heightAnchor.constraint(equalToConstant: 22),
            index.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
            index.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
        ])

        let copy = body(text)
        let row = NSStackView(views: [chip, copy])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 12
        row.setHuggingPriority(.defaultLow, for: .horizontal)
        copy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    /// A wrapping, selectable, non-editable text field. `NSTextField(wrappingLabelWithString:)` is
    /// the only initialiser of the three that both wraps and keeps its intrinsic height, which is
    /// what an NSStackView row needs.
    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.isSelectable = true
        field.drawsBackground = false
        return field
    }

    private func rule() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = NSColor(white: 1, alpha: 0.12).cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }
}
#endif
