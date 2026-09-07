# pi-tui Keybindings for Custom Blocks

> How keyboard input reaches custom TUI components — and how to add a collapse/expand
> toggle to a custom block in a pi extension or custom tool.

This document is written against the local pi installation
(`@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`). The relevant
primary sources are listed in [Sources](#sources); everything here was verified
against them.

---

## 1. Two ways to listen for keys

There are **two distinct mechanisms** and they serve different purposes:

| Mechanism | What it matches | When to use |
|---|---|---|
| `matchesKey(data, Key.*)` from `@earendil-works/pi-tui` | The **physical key** the user pressed (e.g. `up`, `enter`, `ctrl+c`, `shift+tab`) | Keys your component owns privately and are not user-configurable |
| `keybindings.matches(data, "<id>")` on the injected `KeybindingsManager` | A **named action** (e.g. `tui.select.confirm`) that the user can rebind in `~/.pi/agent/keybindings.json` | Anything resembling navigation / confirm / cancel — semantics that users may want to customize |

Every component receives raw terminal input via

```ts
handleInput(data: string): void
```

and decides what to do with it. **If the key isn't handled**, your component
usually just ignores it (or, for custom editors, passes it to `super` — see
[§6](#6-custom-editors-and-app-level-bindings)).

**Key rule:** call `tui.requestRender()` after any state change made inside
`handleInput`, otherwise the screen won't update.

---

## 2. Where factories receive the `keybindings` manager

The `KeybindingsManager` is injected into every "factory" that can build a
custom block:

| API | Factory signature | Notes |
|---|---|---|
| `ctx.ui.custom(factory, opts?)` | `(tui, theme, keybindings, done) => component` | Interactive modal/overlay with keyboard focus |
| `ctx.ui.setEditorComponent(factory)` | `(tui, theme, keybindings) => editor` | Full editor replacement |
| `ctx.ui.setWidget(id, factory)` | `(tui, theme) => ...` | Persistent block above/below the input editor (**no `keybindings` param** — widgets are not focusable) |
| `ctx.ui.setFooter(factory)` | `(tui, theme, footerData) => ...` | Not focusable — no key handling |
| `renderCall` / `renderResult` | `(args/result, { expanded, isPartial }, theme, context)` | Renders blocks *inside the transcript*; keys are handled by the transcript itself, not the block |

So in practice there are three shapes of "custom TUI block":

1. **Interactive component** (`ctx.ui.custom`) — implements `handleInput`,
   calls `done(value)` to close. Full keyboard control. This is where
   `keybindings` matters most.
2. **Transcript block** (`renderCall` / `renderResult`) — decorative; receives
   an `expanded` flag that the transcript toggles for it (see [§5](#5-collapse-and-expand-the-patterns)).
3. **Widget / footer / header** — passive display; no input handling at all.

---

## 3. Physical key matching: `matchesKey` and the `Key` helper

```ts
import { matchesKey, Key } from "@earendil-works/pi-tui";

handleInput(data: string): void {
  if (matchesKey(data, Key.up)) {            // arrow keys
    this.selected--;
  } else if (matchesKey(data, Key.enter)) {  // special keys
    this.onSelect?.(this.selected);
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
  } else if (matchesKey(data, Key.ctrl("c"))) {   // modifier helpers
    // ...Ctrl+C...
  } else if (matchesKey(data, Key.ctrlShift("p"))) {
    // ...Ctrl+Shift+P...
  } else if (matchesKey(data, "shift+tab")) {     // string literals work too
    // ...
  }
}
```

### Valid key identifiers (`KeyId`)

- **Letters** `a`–`z`, **digits** `0`–`9`
- **Symbols**: `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`
- **Special**: `escape`/`esc`, `enter`/`return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`, `f1`–`f12`
- **Modifiers** (combinable): `ctrl`, `shift`, `alt`, `super` → e.g. `ctrl+shift+alt+x`, `super+k`, `ctrl+super+k`

`Key` is a typed helper with autocomplete: `Key.escape`, `Key.backtick`,
`Key.comma`, `Key.ctrl("x")`, `Key.alt("x")`, `Key.super("k")`,
`Key.ctrlShift("p")`, `Key.ctrlAlt("x")`, `Key.ctrlSuper("k")`, etc. Using it
catches typos at compile time.

Caveats:

- Some `ctrl+symbol` combos collide with ASCII control codes (e.g. `ctrl+[` *
is* ESC); those symbols still work for `ctrl+shift` combos.
- `super` bindings require a terminal that reports the modifier separately,
  typically via the Kitty keyboard protocol.

### Kitty protocol extras (modern terminals)

- `isKeyRelease(data)` / `isKeyRepeat(data)` — meaningful when Kitty protocol
  flag 2 is active; pair with `wantsKeyRelease?: true` on your component if you
  need release events.
- `decodeKittyPrintable(data)` — with Kitty flag 1 (disambiguate), *every*
  key arrives as a CSI-u escape sequence, including plain printable characters.
  If your component listens for raw printable text, decode it with this.

---

## 4. Semantic matching: the `KeybindingsManager`

```ts
ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
  const sel = new MySelector(items);
  sel.onSelect = done;
  sel.onCancel = () => done(null);

  return {
    render: (w) => sel.render(w),
    invalidate: () => sel.invalidate(),
    handleInput: (data) => {
      // Match named actions, not hardcoded keys:
      if (keybindings.matches(data, "tui.select.up"))   sel.move(-1);
      else if (keybindings.matches(data, "tui.select.down")) sel.move(1);
      else if (keybindings.matches(data, "tui.select.confirm")) sel.onSelect?.();
      else if (keybindings.matches(data, "tui.select.cancel")) sel.onCancel?.();
      tui.requestRender();
    },
  };
});
```

### Manager API

| Method | Purpose |
|---|---|
| `matches(data, keybindingId)` | True if the raw input matches **any** key bound to that action (respects user overrides). |
| `getKeys(keybindingId)` | The effective key(s) for an action — use for rendering hints like `↑↓ navigate • enter select`. |
| `getDefinition(keybindingId)` | `{ defaultKeys, description }`. |
| `getConflicts()` | Detected collisions (same physical key bound to two actions). |
| `setUserBindings()` / `getUserBindings()` / `getResolvedBindings()` | Programmatic override / inspection of the effective config. |

Because the ids are namespaced, downstream packages (and your own extensions)
can extend the registry via TypeScript declaration merging on
`@earendil-works/pi-tui`'s `Keybindings` interface — this is exactly how
pi-coding-agent adds its `app.*` ids on top of the `tui.*` base set.

### Registered namespaces

**`tui.*` (base, from `@earendil-works/pi-tui`):**

| Namespace | Ids (defaults) |
|---|---|
| `tui.select.*` | `up` (`up`), `down` (`down`), `pageUp` (`pageUp`), `pageDown` (`pageDown`), `confirm` (`enter`), `cancel` (`escape`, `ctrl+c`) — **the ones most custom blocks use** |
| `tui.input.*` | `newLine` (`shift+enter`, `ctrl+j`), `submit` (`enter`), `tab` (`tab`), `copy` (`ctrl+c`) |
| `tui.editor.*` | `cursorUp` (`up`), `cursorDown` (`down`), `cursorLeft` (`left`, `ctrl+b`), `cursorRight` (`right`, `ctrl+f`), `cursorWordLeft` (`alt+left`, `ctrl+left`, `alt+b`), `cursorWordRight` (`alt+right`, `ctrl+right`, `alt+f`), `cursorLineStart` (`home`, `ctrl+home`, `ctrl+a`), `cursorLineEnd` (`end`, `ctrl+end`, `ctrl+e`), `jumpForward` (`ctrl+]`), `jumpBackward` (`ctrl+alt+]`), `deleteCharBackward` (`backspace`), `deleteCharForward` (`delete`, `ctrl+d`), `deleteWordBackward` (`ctrl+w`, `alt+backspace`), `deleteWordForward` (`alt+d`, `alt+delete`), `deleteToLineStart` (`ctrl+u`), `deleteToLineEnd` (`ctrl+k`), `yank` (`ctrl+y`), `yankPop` (`alt+y`), `undo` (`ctrl+-`; `ctrl+z` on Windows), `historyPrevious/Next` (none), `pageUp/Down` (`pageUp`/`pageDown`, `ctrl+pageUp`/`ctrl+pageDown`) |
| `tui.altScreen.*` | Fullscreen transcript viewport: `pageUp`/`pageDown`, `halfPageUp`/`halfPageDown`, `lineUp`/`lineDown` (none), `search` (`ctrl+shift+f`; `ctrl+f` on Windows/WSL), `searchNext` (`enter`, `ctrl+g`), `searchPrevious` (`shift+enter`, `ctrl+shift+g`), `searchClose` (`escape`), `top` (`home`), `bottom` (`end`), `previousPrompt` (`ctrl+shift+up`, `ctrl+up`), `nextPrompt` (`ctrl+shift+down`, `ctrl+down`) |

**`app.*` (added by pi-coding-agent, available in injected managers):**

| Id | Default | Meaning for extensions |
|---|---|---|
| `app.interrupt` | `escape` | Cancel / abort — **your modal should usually let escape do this** |
| `app.clear` | `ctrl+c` | Clear editor |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.model.select` / `app.model.cycleForward` / `app.model.cycleBackward` | `ctrl+l` / `ctrl+p` / `shift+ctrl+p` (`alt+p` Win) | Model switching |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Collapse/expand thinking blocks |
| `app.tools.expand` | `ctrl+o` | **Collapse/expand tool output** — see [§5](#5-collapse-and-expand-the-patterns) |
| `app.editor.external` | `ctrl+g` | External editor |
| `app.message.copy` / `app.message.followUp` / `app.message.dequeue` | `ctrl+x` / `alt+enter` (`ctrl+q` Win) / `alt+up` (`alt+q` Win) | Message queue ops |
| `app.session.*` | see keybindings doc | Session navigation (`new`, `tree`, `fork`, `resume`, `rename`, `delete`, …) |
| `app.tree.*` | see keybindings doc | Session-tree navigation and filters |

### User configuration

Users override anything in `~/.pi/agent/keybindings.json`; your component
picks it up automatically because you matched *ids*, not keys:

```json
{
  "tui.select.up": "alt+k",
  "tui.select.down": "alt+j",
  "tui.select.confirm": ["enter", "ctrl+m"],
  "app.tools.expand": "ctrl+e"
}
```

Each action takes a single key or an array. After editing, `/reload` applies it.
Older pre-namespaced ids (e.g. `cursorUp`, `expandTools`) are migrated
automatically on startup (the internal alias table maps `expandTools` →
`app.tools.expand`).

**Rendering hints from the manager**: instead of hardcoding `"↑↓ navigate • enter select"` in your help line, compute it:

```ts
const up = keybindings.getKeys("tui.select.up")[0];
const down = keybindings.getKeys("tui.select.down")[0];
const ok = keybindings.getKeys("tui.select.confirm")[0];
helpText.setText(theme.fg("dim", `${up}${down} navigate • ${ok} select • esc cancel`));
```

pi-coding-agent additionally exports hint formatters:
`keyHint(id, description)`, `rawKeyHint(key, description)`, `keyText(id)`,
`keyDisplayText(id)` (from `dist/modes/interactive/components/keybinding-hints.d.ts`).

---

## 5. Collapse and expand — the patterns

"Collapse/expand" comes in two very different flavors depending on the block
type. Both are covered below; the distinction is worth internalizing.

### 5a. Transcript tool blocks (`renderCall` / `renderResult`): honor the `expanded` flag

Custom tool renderers receive `{ expanded, isPartial }` in `renderResult`.
`expanded` is owned by the **transcript UI**, not your block: the user toggles
tool output open/closed with the `app.tools.expand` action (**default `ctrl+o`**;
recent example comments saying `ctrl+e` are stale — the registered default in
the installed build is `ctrl+o`) or by clicking. Your job is only to **render
differently depending on the flag**.

Minimal edit pattern for your codebase:

```ts
renderResult(result, { expanded, isPartial }, theme, _context) {
  if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);

  // Collapsed: one summary line
  let text = theme.fg("success", `${details.matchCount} matches`);
  if (details.truncated) text += theme.fg("warning", " (truncated)");

  // Expanded: show the detail content
  if (expanded) {
    const content = result.content[0];
    if (content?.type === "text") {
      for (const line of content.text.split("\n").slice(0, 20)) {
        text += `\n${theme.fg("dim", line)}`;
      }
    }
  }
  return new Text(text, 0, 0);
}
```

**What to edit when adding collapse/expand to a tool renderer:**

1. Read `expanded` in `renderResult` and branch your rendering (short summary
   vs. full detail). Nothing to do around keys — the transcript handles them.
2. Keep the **collapsed** state small: it is the default and appears inline
   in the transcript.
3. Consider surfacing an affordance in the collapsed state (e.g. `▸ N matches`),
   since the toggle shortcut is user-rebindable and not discoverable from your
   block. Use `keyHint("app.tools.expand", "toggle output")` if you want to
   print the effective key.

The `examples/extensions/truncated-tool.ts` and
`examples/extensions/built-in-tool-renderer.ts` are ready-made templates for
this exact pattern (`Text` from `@earendil-works/pi-tui`, theme colors from the
`theme` parameter).

### 5b. Interactive components (`ctx.ui.custom`): own toggle state

Here *you* own the state, because the block is a modal/overlay with keyboard
focus. The edits to make:

1. Add a `private expanded = false` field.
2. In `handleInput`, toggle it on the key you choose — either a physical key
   via `matchesKey`:

```ts
handleInput(data: string): void {
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
    this.expanded = !this.expanded;      // toggle
    this.invalidate();
    tui.requestRender();                  // ALWAYS re-render after state change
  } else if (matchesKey(data, Key.escape) || keybindings.matches(data, "app.interrupt")) {
    this.onCancel?.();
  }
}
```

   or a semantic action via `keybindings.matches(data, "tui.select.confirm")`
   so users can rebind it.

3. Reflect the state in `render()`:

```ts
render(width: number): string[] {
  const lines: string[] = [];
  const header = `${this.expanded ? "▼" : "▶"} ${this.title}  (${this.items.length} items)`;
  lines.push(truncateToWidth(header, width));
  if (this.expanded) {
    for (const item of this.items) lines.push(truncateToWidth(`  ${item}`, width));
  }
  return lines;
}
```

4. Invalidate caches: if you cache `render()` output by width, call
   `invalidate()` before `requestRender()` (or let your `invalidate` clear the
   cached width/lines as in the [caching example](#8-lifecycle-and-performance)).

### 5c. Overlay visibility toggle (`OverlayHandle`)

If the block is a `ctx.ui.custom(..., { overlay: true })`, you can collapse it
to nothing using the overlay handle — no state of your own needed for
visibility:

```ts
let handle: OverlayHandle | undefined;
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    onHandle: (h) => { handle = h; },
  }
);

// elsewhere, e.g. from a registered command or the handleInput of another block:
handle.setHidden(true);   // collapse / hide
handle.setHidden(false);  // expand / show
handle.focus();           // bring to front + grab input
handle.unfocus();         // release input ownership
handle.hide();            // permanently remove (component is disposed)
```

Note overlays are **disposed when closed** — never cache and reuse a stale
component instance; re-invoke `ctx.ui.custom(...)` to re-show.

### 5d. Widget toggle (above/below editor)

Widgets (`ctx.ui.setWidget`) cannot receive keys — they are passive. To make a
persistent status block collapsible, drive its visibility/state from
elsewhere, e.g. a registered command (which can bind `app.tools.expand` if you
want `ctrl+o` semantics) or another component:

```ts
pi.registerCommand("toggle-results", {
  handler: (_args, ctx) => {
    resultsVisible = !resultsVisible;
    ctx.ui.setWidget("my-widget", resultsVisible ? buildLines(theme => ...) : undefined);
  },
});
```

Combine with `setStatus` for a footer hint like `● results hidden`.

---

## 6. Custom editors and app-level bindings

If your block *is* the input editor, extend `CustomEditor` from
`@earendil-works/pi-coding-agent` (not the raw `Editor`), so app-level
keybindings (`escape` abort, `ctrl+d` exit, model switching, thinking cycling,
etc.) keep working:

```ts
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (this.mode === "normal") {
      switch (data) {
        case "i": this.mode = "insert"; return;
        case "h": super.handleInput("\x1b[D"); return; // Left
        case "j": super.handleInput("\x1b[B"); return; // Down
        case "k": super.handleInput("\x1b[A"); return; // Up
        case "l": super.handleInput("\x1b[C"); return; // Right
      }
      // Filter printable chars; pass everything else (ctrl+c, etc.) to super
      if (data.length === 1 && data.charCodeAt(0) >= 32) return;
      super.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape")) { this.mode = "normal"; return; }
    super.handleInput(data); // insert mode: default behavior + app bindings
  }
}

pi.on("session_start", (_event, ctx) => {
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(...));
});
```

**Edit checklist for a custom editor:** handle only the keys your mode owns,
delegate everything else to `super.handleInput(data)`, and add a mode indicator
by modifying the last rendered line (use `truncateToWidth(lastLine, width - label.length, "")` so the label never overflows the width).

---

## 7. Editing checklist for "codebase with a custom TUI block"

To retrofit keybindings support onto an existing custom block:

1. **Locate the factory.** Is it `ctx.ui.custom(...)`, `setEditorComponent(...)`,
   a `renderCall`/`renderResult`, or a `setWidget`? Only the first two receive a
   `keybindings` manager.
2. **Add `handleInput`** if absent (interactive components only). Widgets/footers
   can't take input; transcript blocks can't either.
3. **Decide per key: physical vs semantic.**
   - Navigation / confirm / cancel / scroll → `keybindings.matches(data, "tui.select.*")` (or the closest named action).
   - Keys unique to your feature (e.g. `g` toggling grid view) → `matchesKey(data, Key.g)`.
   - Escape/cancel → `matchesKey(data, Key.escape)` or `keybindings.matches(data, "app.interrupt")`; both are effectively the same and user-rebindable.
4. **Never swallow app-level keys** the user may expect: in `ctx.ui.custom`
   blocks, escape should cancel; in editors, delegate unhandled keys to
   `super.handleInput`.
5. **Call `tui.requestRender()`** after every state change in `handleInput`.
6. **Keep lines ≤ `width`** — use `truncateToWidth(...)` and `visibleWidth(...)`.
7. **Show hints from the manager**: `keybindings.getKeys(id)[0]` or
   `keyHint(id, description)`, not hardcoded key names.
8. **Invalidate caches on theme change** if you pre-bake theme colors (see below).
9. **User-configurability is free** once you match ids — no code change needed
   for `~/.pi/agent/keybindings.json` overrides; mention the id in your docs so
   users know what to rebind.

---

## 8. Lifecycle and performance

- `render(width)` may be called often; cache lines keyed by `width` and clear
  the cache in `invalidate()`:

```ts
invalidate(): void {
  this.cachedWidth = undefined;
  this.cachedLines = undefined;
}
```

- Theme changes call `invalidate()` on every component. If you pre-bake theme
  colors (via `theme.fg(...)`) into cached strings or child components, rebuild
  that content inside your `invalidate()` override — do not just clear caches.
- Each rendered line gets a trailing SGR reset; styles do not carry across
  lines. Reapply styles per line or use `wrapTextWithAnsi()` for wrapped text.
- The TUI appends an OSC 8 reset per line; every line from `render()` **must
  not exceed `width`**.

---

## Sources

- Local pi docs: `docs/tui.md` (component interface, `ctx.ui.custom`, overlays,
  theming, patterns), `docs/keybindings.md` (key format, all action ids and
  defaults, `~/.pi/agent/keybindings.json`) — installed under
  `@earendil-works/pi-coding-agent`.
- Installed type declarations:
  - `@earendil-works/pi-tui/dist/keybindings.d.ts` — `KeybindingsManager` API and `TUI_KEYBINDINGS` defaults.
  - `@earendil-works/pi-tui/dist/keys.d.ts` — `KeyId`, the `Key` helper, `matchesKey`, Kitty helpers.
  - `@earendil-works/pi-coding-agent/dist/core/keybindings.d.ts` — `AppKeybindings`, `KEYBINDINGS` defaults (incl. `app.tools.expand: "ctrl+o"`), alias mapping.
  - `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ctx.ui.custom` / `setEditorComponent` factory signatures.
  - `@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.d.ts` — `keyHint`/`keyText` formatters.
- Upstream (web): `packages/tui/src/keybindings.ts` and `packages/coding-agent/docs/tui.md`
  in the pi repository (`github.com/earendil-works/pi`, historically
  `badlogic/pi-mono`) — source of the namespaced keybinding registry.
- Runnable examples (installed): `examples/extensions/truncated-tool.ts` and
  `built-in-tool-renderer.ts` (expanded-flag tool renderers), `modal-editor.ts`
  and `rainbow-editor.ts` (custom editors), `preset.ts` / `tools.ts`
  (SelectList/SettingsList with `keybindings`), `overlay-qa-tests.ts`
  (overlay visibility toggles), `snake.ts` / `tic-tac-toe.ts` (full
  interactive components).