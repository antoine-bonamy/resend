"use strict";

/* ================= éléments du DOM ================= */
const $ = id => document.getElementById(id);
const method = $("method");
const url = $("url");
const params = $("params");
const headers = $("headers");
const bodyKind = $("bodyKind");
const body = $("body");
const other = $("other");
const msg = $("msg");
const list = $("list");
const filter = $("filter");
const hideStatic = $("hideStatic");
const empty = $("empty");
const runBtn = $("run");
const copyBtn = $("copy");
const formatBtn = $("format");
const clearBtn = $("clear");
const viewToggle = $("viewToggle");
const reqView = $("reqView");
const resView = $("resView");
const resStatus = $("resStatus");
const resHeaders = $("resHeaders");
const resBody = $("resBody");
const showHeaders = $("showHeaders");
const showOther = $("showOther");
const resMime = $("resMime");
const showResHeaders = $("showResHeaders");

/* ================= état ================= */
let origQuery = "";
let origParams = "";
let hash = "";
let current = null;

// Requêtes capturées (plus anciennes en premier) et clés déjà vues pour dédoublonner.
const MAX_ITEMS = 500;
const items = [];
const keys = new Set();
let selectedKey = null
let renderPending = false;

// Entrée HAR sélectionnée (sa réponse est affichée par la vue « Réponse »), mode de coloration
// du body de la réponse, et jeton pour ignorer un chargement de body devenu obsolète.
let selectedEntry = null;
let resMode = "plain";
let resToken = 0;

/* ================= thème clair / sombre des DevTools ================= */
const applyTheme = t => {
    document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
};
applyTheme(browser.devtools.panels.themeName);
browser.devtools.panels.onThemeChanged.addListener(applyTheme);

/* ================= utilitaires ================= */
const setMsg = (text, isError = false) => {
    msg.textContent = text;
    msg.classList.toggle("error", isError);
};

function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
}

const toLines = (pairs, sep) => pairs.map(([k, v]) => k + sep + v).join("\n");

const fromLines = (text, sep) =>
    text.split("\n").filter(l => l.trim()).map(l => {
        const i = l.indexOf(sep, 1);
        if (i < 0) return [l.trim(), ""];
        const v = l.slice(i + sep.length);
        return [l.slice(0, i).trim(), sep === ":" ? v.trim() : v];
    });

const parseJson = (text, label) => {
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${label} : ${e.message}`);
    }
};

/* ================= coloration syntaxique ================= */
// Chaque fonction renvoie une liste de [classe CSS, texte] ; classe vide = texte non coloré.
const JSON_RE = /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(await|fetch)\b/g;

function tokensJson(text) {
    const t = [];
    let last = 0, m;
    JSON_RE.lastIndex = 0;
    while ((m = JSON_RE.exec(text))) {
        if (m.index > last) t.push(["", text.slice(last, m.index)]);
        if (m[1]) {
            t.push([m[2] ? "k" : "s", m[1]]);
            if (m[2]) t.push(["", m[2]]);
        } else if (m[3]) t.push(["l", m[3]]);
        else if (m[4]) t.push(["n", m[4]]);
        else t.push(["w", m[5]]);
        last = JSON_RE.lastIndex;
    }
    if (last < text.length) t.push(["", text.slice(last)]);
    return t;
}

function tokensLines(text, sep) {
    const t = [];
    text.split("\n").forEach((l, i) => {
        if (i) t.push(["", "\n"]);
        const j = l.indexOf(sep, 1);
        if (j < 0) t.push(["k", l]);
        else t.push(["k", l.slice(0, j)], ["", sep], ["s", l.slice(j + sep.length)]);
    });
    return t;
}

// URL sans query string : schéma, hôte, puis segments du chemin (les identifiants ressortent).
const ID_RE = /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;

function tokensPath(path) {
    const t = [];
    path.split(/(\/)/).forEach(p => {
        if (p) t.push([p === "/" ? "p" : ID_RE.test(p) ? "n" : "", p]);
    });
    return t;
}

function tokensUrl(text) {
    const m = /^([a-z][\w+.-]*:\/\/)?([^/?#]*)(.*)$/is.exec(text);
    const t = [];
    if (m[1]) t.push(["p", m[1]]);
    if (m[2]) t.push(["h", m[2]]);
    return t.concat(tokensPath(m[3]));
}

// Query string : « ? », clés, valeurs et séparateurs.
function tokensQuery(search) {
    const t = [];
    search.split(/([?&=])/).forEach((p, i, a) => {
        if (!p) return;
        if (/^[?&=]$/.test(p)) t.push(["p", p]);
        else t.push([a[i - 1] === "=" ? "s" : "k", p]);
    });
    return t;
}

const tokenize = (mode, text) =>
    mode === "json" ? tokensJson(text) : mode === "plain" ? [["", text]] : tokensLines(text, mode);

// Paires d'accolades/crochets hors chaînes : Map position -> position du partenaire.
function bracketPairs(tokens) {
    const pairs = new Map(), stack = [];
    let pos = 0;
    for (const [cls, s] of tokens) {
        if (!cls) {
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (c === "{" || c === "[") stack.push([pos + i, c === "{" ? "}" : "]"]);
                else if (c === "}" || c === "]") {
                    const open = stack.pop();
                    if (open?.[1] === c) {
                        pairs.set(open[0], pos + i);
                        pairs.set(pos + i, open[0]);
                    }
                }
            }
        }
        pos += s.length;
    }
    return pairs;
}

// Isole les caractères aux positions données (triées) dans un jeton de classe "bm".
function markTokens(tokens, positions) {
    if (!positions.length) return tokens;
    const outTokens = [];
    let pos = 0, k = 0;
    for (const [cls, s] of tokens) {
        let from = 0;
        while (k < positions.length && positions[k] < pos + s.length) {
            const i = positions[k++] - pos;
            if (i > from) outTokens.push([cls, s.slice(from, i)]);
            outTokens.push(["bm", s[i]]);
            from = i + 1;
        }
        if (from < s.length) outTokens.push([cls, s.slice(from)]);
        pos += s.length;
    }
    return outTokens;
}

/* ================= aides à l'édition ================= */
const INDENT = "  ";
const OPENERS = {"{": "}", "[": "]", '"': '"'};

const lineStart = (v, pos) => v.lastIndexOf("\n", pos - 1) + 1;

// Remplace [start, end) par text en passant par execCommand pour garder l'historique (Ctrl+Z).
function replaceRange(ta, text, start, end) {
    if (!text && start === end) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    const ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    if (!ok) {
        ta.setRangeText(text, start, end, "end");
        ta.dispatchEvent(new Event("input", {bubbles: true}));
    }
}

const insert = (ta, text) => replaceRange(ta, text, ta.selectionStart, ta.selectionEnd);

// Indente (ou désindente) toutes les lignes touchées par la sélection.
function shiftLines(ta, dedent) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const from = lineStart(v, s);
    let to = v.indexOf("\n", e > s && v[e - 1] === "\n" ? e - 1 : e);
    if (to < 0) to = v.length;
    const text = v.slice(from, to).split("\n")
        .map(l => dedent ? l.replace(/^ {1,2}/, "") : INDENT + l).join("\n");
    if (text === v.slice(from, to)) return;
    replaceRange(ta, text, from, to);
    ta.setSelectionRange(from, from + text.length);
}

function formatJson(ta, label) {
    try {
        const pretty = JSON.stringify(parseJson(ta.value, label), null, 2);
        if (pretty !== ta.value) replaceRange(ta, pretty, 0, ta.value.length);
    } catch (e) {
        setMsg(e.message, true);
    }
}

function attachEditing(ta, mode) {
    ta.addEventListener("keydown", e => {
        if (e.ctrlKey || e.metaKey || e.isComposing) return;
        const json = mode() === "json";
        const v = ta.value, s = ta.selectionStart, end = ta.selectionEnd;
        const next = v[end] ?? "", prev = v[s - 1] ?? "";
        const lineHead = v.slice(lineStart(v, s), s);
        const handled = () => e.preventDefault();

        if (e.altKey) {
            // Alt+Maj+F : reformate le JSON.
            if (json && e.shiftKey && e.code === "KeyF") {
                handled();
                formatJson(ta, "JSON");
            }
            return;
        }

        if (e.key === "Tab") {
            handled();
            if (e.shiftKey || v.slice(s, end).includes("\n")) shiftLines(ta, e.shiftKey);
            else insert(ta, INDENT);
        } else if (e.key === "Enter") {
            // Garde l'indentation de la ligne ; ouvre un bloc après { ou [.
            handled();
            const indent = /^ */.exec(lineHead)[0];
            const opener = json && OPENERS[lineHead.trimEnd().slice(-1)];
            if (opener && opener !== '"') {
                const inner = "\n" + indent + INDENT;
                insert(ta, next === opener ? inner + "\n" + indent : inner);
                ta.setSelectionRange(s + inner.length, s + inner.length);
            } else {
                insert(ta, "\n" + indent);
            }
        } else if (e.key === "Backspace" && s === end && s > 0) {
            if (json && OPENERS[prev] && OPENERS[prev] === next) {
                // Supprime une paire vide : {|} -> |
                handled();
                replaceRange(ta, "", s - 1, s + 1);
            } else if (lineHead && /^ +$/.test(lineHead)) {
                // Dans l'indentation : recule d'un niveau.
                handled();
                replaceRange(ta, "", s - ((lineHead.length - 1) % INDENT.length + 1), s);
            }
        } else if (json && (e.key === "}" || e.key === "]" || e.key === '"') && s === end && next === e.key
            && (e.key !== '"' || prev !== "\\")) {
            // Saute le caractère fermant déjà présent.
            handled();
            ta.setSelectionRange(s + 1, s + 1);
        } else if (json && (e.key === "}" || e.key === "]") && s === end && /^ +$/.test(lineHead)) {
            // Une fermeture seule sur sa ligne se désindente.
            handled();
            replaceRange(ta, lineHead.slice(INDENT.length) + e.key, s - lineHead.length, s);
        } else if (json && OPENERS[e.key]) {
            const close = OPENERS[e.key];
            if (s !== end) {
                // Entoure la sélection.
                handled();
                const sel = v.slice(s, end);
                insert(ta, e.key + sel + close);
                ta.setSelectionRange(s + 1, s + 1 + sel.length);
            } else if (/^$|[\s,:\]}]/.test(next) && (e.key !== '"' || !/[\w"\\]/.test(prev))) {
                // Ferme automatiquement si le curseur n'est pas collé à du texte.
                handled();
                insert(ta, e.key + close);
                ta.setSelectionRange(s + 1, s + 1);
            }
        }
    });
}

/* ================= éditeur coloré ================= */
const editors = [];
const refreshAll = () => editors.forEach(refresh => refresh());

// Remplace le textarea par un <pre> coloré surmonté du textarea transparent.
// mode() renvoie "json", "plain", ou le séparateur clé/valeur (":" ou "=").
function makeEditor(ta, mode) {
    const wrap = document.createElement("div");
    wrap.className = "ed";
    const pre = document.createElement("pre");
    pre.setAttribute("aria-hidden", "true");
    const code = document.createElement("code");
    pre.append(code);
    ta.replaceWith(wrap);
    wrap.append(pre, ta);

    const minLines = +ta.dataset.min || 3;
    let lastKey = null, pairsText = null, pairs = null;

    const sync = () => {
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener("scroll", sync);

    // Accolade ou crochet sous le curseur et son partenaire, en JSON dans un champ modifiable.
    const marks = (m, text) => {
        if (m !== "json" || ta.readOnly || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) return [];
        if (pairsText !== text) {
            pairsText = text;
            pairs = bracketPairs(tokensJson(text));
        }
        const c = ta.selectionStart;
        const at = pairs.has(c - 1) ? c - 1 : pairs.has(c) ? c : -1;
        return at < 0 ? [] : [at, pairs.get(at)].sort((a, b) => a - b);
    };

    const refresh = () => {
        const m = mode(), text = ta.value, mk = marks(m, text), key = m + "\0" + mk + "\0" + text;
        if (key !== lastKey) {
            lastKey = key;
            const frag = document.createDocumentFragment();
            for (const [cls, s] of markTokens(tokenize(m, text), mk)) frag.append(cls ? span(cls, s) : s);
            code.replaceChildren(frag);
            // Hauteur automatique : 18px par ligne + marges, plafonnée à 60vh par le CSS.
            const lines = Math.max(minLines, text.split("\n").length);
            wrap.style.height = lines * 18 + 30 + "px";
        }
        sync();
    };
    editors.push(refresh);
    for (const ev of ["selectionchange", "keyup", "click", "focus", "blur"]) ta.addEventListener(ev, refresh);
    if (!ta.readOnly) attachEditing(ta, mode);
    return wrap;
}

makeEditor(params, () => "=");
makeEditor(headers, () => ":");
makeEditor(body, () => ({json: "json", form: "="})[bodyKind.value] ?? "plain");
makeEditor(other, () => "json");
makeEditor(resHeaders, () => ":");
makeEditor(resBody, () => resMode);

// Champ URL : même principe sur une seule ligne, coloré selon la composition de l'URL.
{
    const wrap = document.createElement("div");
    wrap.className = "urlbox";
    const pre = document.createElement("pre");
    pre.setAttribute("aria-hidden", "true");
    url.replaceWith(wrap);
    wrap.append(pre, url);
    let last = null;
    const sync = () => {
        pre.scrollLeft = url.scrollLeft;
    };
    for (const ev of ["scroll", "input", "keyup", "click", "select", "focus", "blur"]) url.addEventListener(ev, sync);
    editors.push(() => {
        if (url.value !== last) {
            last = url.value;
            pre.replaceChildren(tokenSpans(document.createDocumentFragment(), tokensUrl(last)));
        }
        sync();
    });
}
/* ================= menu des méthodes ================= */
// Les options d'un <select> natif ne peuvent pas être colorées de façon fiable dans Firefox :
// le <select> reste caché comme source de vérité, et ce menu l'affiche et le pilote.
const methodBtn = $("methodBtn"), methodList = $("methodList");

function syncMethod() {
    methodBtn.textContent = method.value;
    methodBtn.dataset.method = method.value;
}

function closeMethods(focusBtn) {
    methodList.hidden = true;
    methodBtn.setAttribute("aria-expanded", "false");
    if (focusBtn) methodBtn.focus();
}

function openMethods() {
    methodList.replaceChildren(...[...method.options].map(o => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.tabIndex = -1;
        li.textContent = o.value;
        li.dataset.method = o.value;
        li.setAttribute("aria-selected", String(o.value === method.value));
        return li;
    }));
    methodList.hidden = false;
    methodBtn.setAttribute("aria-expanded", "true");
    methodList.querySelector('[aria-selected="true"]')?.focus();
}

function pickMethod(value) {
    closeMethods(true);
    if (value === method.value) return;
    method.value = value;
    syncMethod();
    method.dispatchEvent(new Event("change", {bubbles: true}));
}

methodBtn.addEventListener("click", () => (methodList.hidden ? openMethods() : closeMethods(false)));
methodBtn.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMethods();
    }
});
methodList.addEventListener("click", e => {
    const li = e.target.closest("li");
    if (li) pickMethod(li.dataset.method);
});
methodList.addEventListener("keydown", e => {
    const li = e.target.closest("li");
    if (!li) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        (e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling)?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pickMethod(li.dataset.method);
    } else if (e.key === "Escape") {
        closeMethods(true);
    } else if (e.key === "Tab") {
        closeMethods(false);
    }
});
document.addEventListener("click", e => {
    if (!methodList.hidden && !e.target.closest(".msel")) closeMethods(false);
});
syncMethod();

/* ================= état -> champs ================= */
function setState({url: fullUrl, method: me = "GET", headers: hs = [], body: b = null, other: rest = {}}) {
    let u = String(fullUrl);
    const hi = u.indexOf("#");
    hash = hi < 0 ? "" : u.slice(hi);
    if (hi >= 0) u = u.slice(0, hi);
    const qi = u.indexOf("?");
    origQuery = qi < 0 ? "" : u.slice(qi + 1);
    url.value = qi < 0 ? u : u.slice(0, qi);
    origParams = toLines([...new URLSearchParams(origQuery)], "=");
    params.value = origParams;

    // Une méthode hors de la liste (ex. PROPFIND) est ajoutée au menu pour ne pas être perdue.
    me = me.toUpperCase();
    if (![...method.options].some(o => o.value === me)) method.add(new Option(me));
    method.value = me;
    syncMethod();
    headers.value = toLines(hs, ": ");
    other.value = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "";

    if (b == null || b === "") {
        bodyKind.value = "none";
        body.value = "";
    } else {
        try {
            body.value = JSON.stringify(JSON.parse(b), null, 2);
            bodyKind.value = "json";
        } catch {
            const ct = hs.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
            if (ct.includes("urlencoded")) {
                body.value = toLines([...new URLSearchParams(b)], "=");
                bodyKind.value = "form";
            } else {
                body.value = b;
                bodyKind.value = "raw";
            }
        }
    }
    build();
}

/* ================= champs -> fetch ================= */
function build() {
    try {
        const opts = other.value.trim() ? parseJson(other.value, "Options") : {};
        const h = Object.fromEntries(fromLines(headers.value, ":"));
        if (Object.keys(h).length) opts.headers = h;

        switch (bodyKind.value) {
            case "json":
                // Valide le JSON puis le re-minifie, comme le fait Firefox.
                opts.body = JSON.stringify(parseJson(body.value, "JSON body"));
                break;
            case "form":
                opts.body = new URLSearchParams(fromLines(body.value, "=")).toString();
                break;
            case "raw":
                opts.body = body.value;
                break;
        }
        opts.method = method.value;

        // On ne ré-encode la query string que si elle a été modifiée.
        const q = params.value === origParams
            ? origQuery
            : new URLSearchParams(fromLines(params.value, "=")).toString();
        const full = url.value.trim() + (q ? "?" + q : "") + hash;
        if (!full) throw new Error("Empty URL: pick a request from the list.");

        current = {url: full, opts};
        setMsg(
            "body" in opts && /^(GET|HEAD)$/.test(opts.method)
                ? "Warning: fetch rejects a body with GET or HEAD."
                : ""
        );
    } catch (e) {
        current = null;
        setMsg(e.message, true);
    } finally {
        copyBtn.disabled = runBtn.disabled = !current;
        refreshAll();
    }
}

/* ================= requêtes de la page ================= */
const STATIC_RE = /^(image|font|audio|video)\/|css|javascript|ecmascript|wasm/i;
// En-têtes que fetch() refuse de toute façon : inutile de les afficher.
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt",
    "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer",
    "transfer-encoding", "upgrade", "via"]);
const isForbidden = n => {
    n = n.toLowerCase();
    return FORBIDDEN.has(n) || n.startsWith("proxy-") || n.startsWith("sec-") || n.startsWith(":");
};

function entryToState(entry) {
    const r = entry.request;
    const hs = (r.headers || []).map(h => [h.name, h.value]);
    const get = n => hs.find(([k]) => k.toLowerCase() === n)?.[1];
    const rest = {credentials: get("cookie") || get("authorization") ? "include" : "omit"};
    if (get("referer")) rest.referrer = get("referer");
    rest.mode = "cors";
    return {
        url: r.url,
        method: r.method,
        headers: hs.filter(([k]) => !isForbidden(k)),
        body: r.postData?.text ?? null,
        other: rest,
    };
}

// Ajoute une entrée (requête ou marqueur de navigation) en gardant au plus MAX_ITEMS éléments.
function pushItem(item) {
    items.push(item);
    if (items.length > MAX_ITEMS) {
        const old = items.shift();
        if (old.key) keys.delete(old.key);
    }
    scheduleRender();
}

function addEntry(entry) {
    const r = entry?.request;
    if (!r?.url) return;
    const key = `${entry.startedDateTime}|${r.method}|${r.url}`;
    if (keys.has(key)) return;
    keys.add(key);
    let path = r.url, query = "", host = "";
    try {
        const u = new URL(r.url);
        path = u.pathname;
        query = u.search;
        host = u.host;
    } catch {
    }
    pushItem({
        key, entry, path, query, host,
        status: entry.response?.status || 0,
        isStatic: STATIC_RE.test(entry.response?.content?.mimeType ?? ""),
        search: (r.method + " " + r.url).toLowerCase(),
    });
}

function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
        renderPending = false;
        renderList();
    });
}

function tokenSpans(parent, tokens) {
    for (const [cls, s] of tokens) parent.append(cls ? span(cls, s) : s);
    return parent;
}

const pathSpan = it => tokenSpans(span("pa", ""), [...tokensPath(it.path), ...tokensQuery(it.query)]);

// Classe de couleur selon la famille du code HTTP : s2 (succès) … s5 (erreur serveur), s0 sans réponse.
const statusClass = st => "s" + (st >= 100 && st < 600 ? Math.floor(st / 100) : 0);

function renderItem(it, i) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "req";
    if (it.key === selectedKey) {
        b.classList.add("sel");
        b.setAttribute("aria-current", "true");
    }
    b.dataset.i = i;
    b.title = it.entry.request.url;
    const st = it.status;
    b.append(
        span("st " + statusClass(st), st ? String(st) : "—"),
        span("me", it.entry.request.method),
        pathSpan(it),
        span("ho", it.host),
    );
    b.children[1].dataset.method = it.entry.request.method.toUpperCase();
    return b;
}

function renderList() {
    const q = filter.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (let i = items.length - 1; i >= 0; i--) {          // plus récentes en haut
        const it = items[i];
        const li = document.createElement("li");
        if (it.nav) {
            li.className = "nav";
            li.textContent = "↑ navigated to " + it.url;
        } else if ((hideStatic.checked && it.isStatic) || (q && !it.search.includes(q))) {
            continue;
        } else {
            li.append(renderItem(it, i));
            shown++;
        }
        frag.append(li);
    }
    list.replaceChildren(frag);
    empty.hidden = shown > 0;
}

list.addEventListener("click", e => {
    const b = e.target.closest("button[data-i]");
    const it = b && items[+b.dataset.i];
    if (!it) return;
    selectedKey = it.key;
    selectedEntry = it.entry;
    setState(entryToState(it.entry));
    renderList();
    if (viewToggle.checked) showResponse();
});

filter.addEventListener("input", renderList);
hideStatic.addEventListener("change", renderList);
clearBtn.addEventListener("click", () => {
    items.length = 0;
    keys.clear();
    renderList();
});

browser.devtools.network.onRequestFinished.addListener(addEntry);
browser.devtools.network.onNavigated.addListener(navUrl => pushItem({nav: true, url: navUrl}));
// Requêtes déjà enregistrées avant l'ouverture du panneau.
browser.devtools.network.getHAR()
    .then(har => (har?.entries ?? har?.log?.entries ?? []).forEach(addEntry))
    .catch(() => {
    });

/* ================= vue réponse ================= */
const BINARY_RE = /^(image|font|audio|video)\/|octet-stream|wasm|zip|pdf/i;
const MAX_HIGHLIGHT = 200_000;   // au-delà, le body n'est pas coloré pour rester fluide

function setResponse(headerText, bodyText, mode) {
    resHeaders.value = headerText;
    resBody.value = bodyText;
    resMode = mode;
    refreshAll();
}

// Body de la réponse : getContent() n'existe que sur les entrées reçues en direct,
// celles de getHAR() peuvent avoir le texte dans content.text.
async function responseText(entry) {
    if (typeof entry.getContent !== "function") return entry.response.content?.text ?? "";
    const c = await entry.getContent();
    return (Array.isArray(c) ? c[0] : c) ?? "";   // Firefox renvoie [contenu, type MIME]
}

function formatBody(text, mime) {
    if (BINARY_RE.test(mime)) return ["(binary content not shown)", "plain"];
    if (!text) return ["(empty body)", "plain"];
    try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        return [pretty, pretty.length > MAX_HIGHLIGHT ? "plain" : "json"];
    } catch {
        return [text, "plain"];
    }
}

async function showResponse() {
    const token = ++resToken;
    const res = selectedEntry?.response;
    if (!res) {
        resStatus.hidden = true;
        resMime.textContent = "Select a request from the list to see its response.";
        setResponse("", "", "plain");
        return;
    }
    const mime = res.content?.mimeType ?? "";
    resStatus.hidden = false;
    resStatus.className = "status " + statusClass(res.status);
    resStatus.textContent = res.status ? `${res.status} ${res.statusText ?? ""}`.trim() : "No response";
    resMime.textContent = mime;
    const headerText = toLines((res.headers || []).map(h => [h.name, h.value]), ": ");
    setResponse(headerText, "Loading…", "plain");

    let text;
    try {
        text = await responseText(selectedEntry);
    } catch (e) {
        text = "Could not read body: " + e.message;
    }
    if (token !== resToken) return;   // une autre requête a été sélectionnée entre-temps
    setResponse(headerText, ...formatBody(text, mime));
}

viewToggle.addEventListener("change", () => {
    const showRes = viewToggle.checked;
    reqView.hidden = showRes;
    resView.hidden = !showRes;
    if (showRes) showResponse();
});

/* ================= actions ================= */
function evalErrorMessage(err) {
    if (err.isException) return "exception in page: " + err.value;
    let i = 0;
    const raw = String(err.description || err.code || "unknown error")
        .replace(/%s/g, () => err.details?.[i++] ?? "");
    if (/not allowed on the current inspected window|system principal/i.test(raw)) {
        return "Firefox doesn't allow extensions to run code on this page " +
            "(about:…, addons.mozilla.org, PDF viewer…). Open the DevTools on the target site's tab. — " + raw;
    }
    return raw;
}

runBtn.addEventListener("click", async () => {
    if (!current) return;
    const js = `void fetch(${JSON.stringify(current.url)}, ${JSON.stringify(current.opts)})
    .then(async r => {
      const t = await r.text();
      let d = t;
      try { d = JSON.parse(t); } catch {}
      console.log("[Resend]", r.status, r.statusText, d);
    })
    .catch(e => console.error("[Resend]", e));`;
    try {
        const [, err] = await browser.devtools.inspectedWindow.eval(js);
        if (err) setMsg("Send failed: " + evalErrorMessage(err), true);
        else setMsg("Request sent: it will appear at the top of the list. Select it and switch to Response (or check the Console).");
    } catch (e) {
        setMsg("Send failed: " + e.message, true);
    }
});

copyBtn.addEventListener("click", async () => {
    if (!current) return;
    const text = `await fetch(${JSON.stringify(current.url)}, ${JSON.stringify(current.opts, null, 4)});`;
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
    setMsg("Fetch copied to clipboard.");
});

formatBtn.addEventListener("click", () => {
    if (bodyKind.value === "json") formatJson(body, "JSON body");
});

$("work").addEventListener("input", build);
$("work").addEventListener("change", build);

/* ================= affichage des sections En-têtes / Options ================= */

// Les sections masquées restent prises en compte dans le fetch. Le choix est mémorisé.
function bindSection(box, input, storeKey) {
    try {
        input.checked = localStorage.getItem(storeKey) !== "0";
    } catch {
    }
    const apply = () => {
        $(box).hidden = !input.checked;
        try {
            localStorage.setItem(storeKey, input.checked ? "1" : "0");
        } catch {
        }
        refreshAll();
    };
    input.addEventListener("change", apply);
    apply();
}

bindSection("headersBox", showHeaders, "showHeaders");
bindSection("otherBox", showOther, "showOther");
bindSection("resHeadersBox", showResHeaders, "showResHeaders");

refreshAll();
renderList();
