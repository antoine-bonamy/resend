# Resend

A Firefox DevTools panel to pick any request made by the page, edit it, send it again and inspect the response.

Firefox's Network panel can already "Edit and Resend" a request, but its editor is a small raw form. Resend gives each part of the request its own editor (query params, headers, body, fetch options) and highlights their syntax. It also shows the response right next to the request.

## Features

- **Request list**: every request made by the inspected page, newest first, with method, status, path and host.
  - Filter by URL or method.
  - Hide static files (images, CSS, JS, fonts).
  - Page navigations are marked in the list.
- **Request editor**:
  - Method and URL. The URL is colored to show its structure: host, path segments, IDs.
  - Query params, one `key=value` per line, decoded.
  - Headers, one `Name: value` per line. Headers that `fetch()` is not allowed to set are left out.
  - Body as JSON, form (`key=value` lines) or plain text.
  - Other `fetch()` options as JSON (`credentials`, `mode`, `referrer`…).
  - The Headers and Options sections can be hidden. Hidden sections still apply to the request.
- **JSON editing**:
  - Syntax highlighting.
  - Auto-indentation.
  - Auto-closing brackets and quotes.
  - Highlighting of the bracket that matches the one at the cursor.
  - One-key formatting.
- **Send**: runs the request with `fetch()` inside the inspected page, so it uses the page's origin, cookies and session. The new request then appears at the top of the list, and its result is also logged to the Console.
- **Copy fetch**: copies the request as an `await fetch(…)` snippet.
- **Response view**:
  - Status badge colored by class (2xx, 3xx, 4xx, 5xx).
  - Content type.
  - Headers, which can be hidden.
  - Body, pretty-printed when it is JSON.
- Follows the DevTools light or dark theme.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Tab` / `Shift+Tab` | Indent / unindent the current line or selected lines |
| `Enter` | New line, keeping indentation (opens an indented block after `{` or `[`) |
| `Backspace` in indentation | Remove one indentation level |
| `Alt+Shift+F` | Format the JSON in the current field |
| `↑` / `↓` on the method button | Open the method menu |

## Installation

Requires Firefox 140 or later.

### From source (temporary)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json`.
3. Open the DevTools (`F12`) on any page and go to the **Resend** tab.

The extension stays installed until Firefox restarts.

## Usage

1. Open the **Resend** panel, then reload the page or trigger the action you want to replay.
2. Select a request in the list. Its method, URL, params, headers and body are loaded in the editor.
3. Edit anything you need, then click **Send**.
4. Select the new request at the top of the list and switch the toggle to **Response** to see what came back.

Firefox does not let extensions run code on some pages (`about:` pages, addons.mozilla.org, the PDF viewer). **Send** does not work there.

## Packaging

Run:

```sh
./package.sh
```

The archive is created as `dist/resend-<version>.zip`, ready to upload to [addons.mozilla.org](https://addons.mozilla.org/developers/). The version comes from `manifest.json`.

In IntelliJ, the shared **Package extension** run configuration runs the same script.

## Privacy

Resend does not collect or send any data, and needs no special permission. Requests are only sent when you click **Send**, from the inspected page itself. The only thing stored is which sections are shown or hidden, in the extension's local storage.

## Project structure

| File | Role |
|---|---|
| `manifest.json` | Extension manifest |
| `devtools.html`, `devtools.js` | Registers the DevTools panel |
| `panel.html`, `panel.css`, `panel.js` | The panel: request list, editors and response view |
| `icons/icon.svg` | Extension icon |
| `package.sh` | Builds the archive for addons.mozilla.org |

## License

[MIT](LICENSE)
