import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useSharedChatData } from "../sharedChatData.js";

// Lazy-load this component's stylesheet exactly once. Same trick the
// calendar / sorted routes use: the parent index.html doesn't ship
// the CSS, so it only arrives the first time a chat with the
// reaction component actually mounts.
function ensureStylesheet() {
  const href = new URL("./style.css", import.meta.url).href;
  if (document.querySelector(`link[data-component-style="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.componentStyle = href;
  document.head.appendChild(link);
}

// The fixed set of reactions the picker offers. Matching the spec —
// heart, thumbs up, smiley face — and stored as compact ids in
// Graffiti so the on-the-wire shape is small and easy to filter on.
// `glyph` is what we render; `id` is what we persist.
const REACTION_OPTIONS = [
  { id: "heart", glyph: "\u2764\uFE0F", label: "Heart" },
  { id: "thumbsup", glyph: "\u{1F44D}", label: "Thumbs up" },
  { id: "smiley", glyph: "\u{1F642}", label: "Smiley face" },
];

function setup(props) {
  // The reactions stream and the two mutations live in the shared
  // composable so every chat-aware page (including this component
  // mounted N times in the message list) reuses the same discovery.
  const { session, reactionsByMessageUrl, addReaction, removeReaction } =
    useSharedChatData();

  // Whether the picker menu is showing for *this* message. Each
  // <reaction> instance owns its own ref so opening the menu on one
  // message doesn't toggle it on the others.
  const menuOpen = ref(false);

  function toggleMenu() {
    menuOpen.value = !menuOpen.value;
  }

  function closeMenu() {
    menuOpen.value = false;
  }

  // Bound via `ref="rootEl"` on this component's root element so the
  // doc-click handler can tell "click was inside *my* reaction
  // component" from "click was inside a sibling message's reaction
  // component". Without this disambiguation, opening one menu would
  // immediately close it because the trigger click bubbles up to
  // document.
  const rootEl = ref(null);

  // Click-outside dismissal. The menu's own buttons stop propagation
  // so they don't trigger this. Keyboard users can also press Escape
  // (handled below).
  function handleDocClick(event) {
    if (!menuOpen.value) return;
    if (rootEl.value && rootEl.value.contains(event.target)) return;
    closeMenu();
  }

  function handleKey(event) {
    if (event.key === "Escape" && menuOpen.value) {
      closeMenu();
    }
  }

  onMounted(() => {
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKey);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("click", handleDocClick);
    document.removeEventListener("keydown", handleKey);
  });

  // All reactions targeting the message this instance is rendered for.
  const reactionsForMessage = computed(
    () => reactionsByMessageUrl.value.get(props.message?.url) ?? [],
  );

  const myReactions = computed(() => {
    const me = session.value?.actor;
    if (!me) return [];
    return reactionsForMessage.value.filter((r) => r.actor === me);
  });

  function hasMyReaction(emoji) {
    return myReactions.value.some((r) => r.value.emoji === emoji);
  }

  // Bucket every reaction on this message by emoji, in the picker's
  // canonical order (so chips never visually shuffle as new reactions
  // arrive). Unknown emojis from other apps would just be skipped —
  // graffiti is interoperable, so the schema can't fully constrain
  // what shows up in our channel.
  const reactionGroups = computed(() => {
    const me = session.value?.actor;
    const groups = new Map();
    for (const r of reactionsForMessage.value) {
      const e = r.value.emoji;
      const opt = REACTION_OPTIONS.find((o) => o.id === e);
      if (!opt) continue;
      const g = groups.get(e);
      if (g) {
        g.count++;
        if (r.actor === me) g.mine = r;
      } else {
        groups.set(e, {
          emoji: e,
          glyph: opt.glyph,
          label: opt.label,
          count: 1,
          mine: r.actor === me ? r : null,
        });
      }
    }
    // Order chips the same way as the menu so the layout doesn't
    // depend on which emoji someone happened to pick first.
    const ordered = [];
    for (const opt of REACTION_OPTIONS) {
      const g = groups.get(opt.id);
      if (g) ordered.push(g);
    }
    return ordered.map((g) => ({
      ...g,
      title: g.mine
        ? `${g.label} (${g.count}) — click to remove yours`
        : `${g.label} (${g.count})`,
    }));
  });

  // True when the message we're rendering for was sent by the logged-
  // in user. Drives the trigger position (left for mine, right for
  // others) via a CSS class on the root.
  const isMine = computed(
    () => !!session.value && props.message?.actor === session.value.actor,
  );

  // Picker click: add the chosen reaction (or, if the user already
  // has it, remove it — same toggle as clicking the chip itself).
  // Always closes the menu so the picker doesn't linger after a
  // selection.
  async function pickReaction(emoji) {
    closeMenu();
    if (!props.message || !props.chat) return;
    const mine = myReactions.value.find((r) => r.value.emoji === emoji);
    if (mine) {
      await removeReaction(mine.url);
    } else {
      await addReaction(props.message, props.chat, emoji);
    }
  }

  // Chip click: add my reaction with this emoji, or pull mine off if
  // I'm already in this group. The "stack only with multiple people"
  // rule from the spec falls out naturally — `addReaction` no-ops
  // when I've already reacted with the same emoji, so the only way
  // a chip's count goes up is when *another* actor is added.
  async function toggleReaction(emoji) {
    if (!props.message || !props.chat) return;
    const mine = myReactions.value.find((r) => r.value.emoji === emoji);
    if (mine) {
      await removeReaction(mine.url);
    } else {
      await addReaction(props.message, props.chat, emoji);
    }
  }

  return {
    rootEl,
    menuOpen,
    REACTION_OPTIONS,
    reactionGroups,
    hasMyReaction,
    isMine,
    toggleMenu,
    pickReaction,
    toggleReaction,
  };
}

export default async () => {
  ensureStylesheet();
  return {
    name: "Reaction",
    props: {
      message: { type: Object, required: true },
      chat: { type: Object, required: true },
    },
    setup,
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
      r.text(),
    ),
  };
};
