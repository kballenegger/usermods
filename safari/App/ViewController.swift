#if os(iOS)
import UIKit

/// The one screen the host app has on iOS. The Mac version is App/MacViewController.swift.
///
/// On iOS a Safari web extension cannot be installed by itself. It ships inside an app, and turning
/// it on happens in Settings, which no app can deep link into. So this screen exists to answer the
/// question someone has right after installing: where is it, and why is nothing happening yet.
///
/// macOS is the same shape with one difference that is worth the separate file: there, the app can
/// open the extension's own settings pane, so the Mac screen has a button and this one cannot.
///
/// The colours are the BBS Underground tokens from docs/branding.md, spelled out here because a
/// native screen cannot read the extension's CSS.
final class ViewController: UIViewController {
    private enum Brand {
        /// --brand-ink
        static let ink = UIColor(red: 0x03 / 255, green: 0x0B / 255, blue: 0x16 / 255, alpha: 1)
        /// --brand-lime
        static let lime = UIColor(red: 0xAE / 255, green: 0xFF / 255, blue: 0x24 / 255, alpha: 1)
        static let text = UIColor(white: 0.92, alpha: 1)
        static let dim = UIColor(white: 0.62, alpha: 1)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.ink

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(heading("usermods"))
        stack.addArrangedSubview(
            body(
                "Customise any website by chatting with a model. The extension lives in Safari, "
                    + "not in this app, so there is one switch to flip before it appears."
            )
        )
        stack.addArrangedSubview(rule())
        stack.addArrangedSubview(step(1, "Open Settings, then Apps, then Safari, then Extensions."))
        stack.addArrangedSubview(step(2, "Turn usermods on."))
        stack.addArrangedSubview(step(3, "Set its site access to Allow on All Websites. A userscript manager cannot work per-tap."))
        stack.addArrangedSubview(step(4, "In Safari, tap the page menu in the address bar and choose usermods."))
        stack.addArrangedSubview(rule())
        stack.addArrangedSubview(
            note(
                "Add a model provider API key in Settings inside the extension before you chat. "
                    + "A model running on your computer is not reachable at localhost from this device: "
                    + "use that computer's address on your network instead."
            )
        )

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.addSubview(stack)
        view.addSubview(scroll)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: guide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: scroll.bottomAnchor, constant: -28),
            stack.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor, constant: -48),
        ])
    }

    private func heading(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = Brand.lime
        label.font = .monospacedSystemFont(ofSize: 32, weight: .bold)
        return label
    }

    private func body(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = Brand.text
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

    private func step(_ number: Int, _ text: String) -> UIView {
        let index = UILabel()
        index.text = "\(number)"
        index.textColor = Brand.ink
        index.backgroundColor = Brand.lime
        index.textAlignment = .center
        index.font = .monospacedSystemFont(ofSize: 15, weight: .bold)
        index.layer.cornerRadius = 4
        index.clipsToBounds = true
        index.translatesAutoresizingMaskIntoConstraints = false
        index.widthAnchor.constraint(equalToConstant: 26).isActive = true
        index.heightAnchor.constraint(equalToConstant: 26).isActive = true

        let row = UIStackView(arrangedSubviews: [index, body(text)])
        row.axis = .horizontal
        row.spacing = 12
        row.alignment = .top
        return row
    }

    private func note(_ text: String) -> UILabel {
        let label = body(text)
        label.textColor = Brand.dim
        label.font = .preferredFont(forTextStyle: .footnote)
        return label
    }

    private func rule() -> UIView {
        let line = UIView()
        line.backgroundColor = UIColor(white: 1, alpha: 0.12)
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }
}
#endif
