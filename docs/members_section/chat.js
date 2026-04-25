import { ref, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useSharedChatData, displayHandle } from "../sharedChatData.js";

// Lazy-load this component's stylesheet exactly once. Same trick the
// /#/sorted and /#/calendar routes use: ship the members panel's CSS
// from inside its own folder so the file owns its presentation, and
// skip the network if some other instance has already attached the
// link tag.
function ensureStylesheet() {
  const href = new URL("./style.css", import.meta.url).href;
  if (document.querySelector(`link[data-component-style="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.componentStyle = href;
  document.head.appendChild(link);
}

function setup(props) {
  const router = useRouter();

  // The shared composable owns the Graffiti session ref plus the
  // mutations the panel actually needs. Pulling them from here (vs.
  // re-querying with useGraffitiSession()/useGraffiti()) means the
  // panel piggy-backs on the singleton initialized by the root App
  // and doesn't spin up extra discovery polls.
  const { session, addMemberToChat, leaveChat } = useSharedChatData();

  // Only the chat's creator can change its allowed list (Graffiti
  // doesn't let other users mutate someone else's object), so the
  // "add member" form gates on this. Derived from the prop so a
  // route-driven chat swap recomputes ownership for the new chat.
  const isOwner = computed(
    () =>
      !!props.chat &&
      !!session.value &&
      props.chat.actor === session.value.actor,
  );

  // ---- Add-member form state ----------------------------------------
  //
  // Local to the panel: a half-typed handle for chat A would be
  // confusing if it bled into chat B's input, and the busy/error
  // flags are only meaningful while *this* panel is the one mounted.
  const newMemberHandle = ref("");
  const isAddingMember = ref(false);
  const addMemberError = ref("");

  // Reset the form whenever the user navigates to a different chat so
  // a stale typed handle / error from the previous chat doesn't carry
  // over. Watching `chat.url` (rather than `chat`) keeps us from
  // resetting on the constant identity-stable re-renders the parent
  // emits when the chat object's contents update in place.
  watch(
    () => props.chat?.url,
    () => {
      newMemberHandle.value = "";
      addMemberError.value = "";
    },
  );

  async function addUserToChat() {
    addMemberError.value = "";
    if (!props.chat) return;
    const handle = newMemberHandle.value.trim();
    if (!handle) return;

    isAddingMember.value = true;
    try {
      await addMemberToChat(props.chat, handle);
      newMemberHandle.value = "";
    } catch (err) {
      addMemberError.value = err?.message ?? "Could not add that user.";
    } finally {
      isAddingMember.value = false;
    }
  }

  // ---- Leave-confirmation modal state -------------------------------
  //
  // Lives inside the panel because the trigger ("Leave chat" button)
  // does too. The modal itself <teleport>s to <body> so it isn't
  // clipped by #members-panel's overflow context.
  const isLeaveDialogOpen = ref(false);
  const isLeavingChat = ref(false);

  function requestLeaveChat() {
    if (!props.chat) return;
    isLeaveDialogOpen.value = true;
  }

  function cancelLeaveChat() {
    if (isLeavingChat.value) return;
    isLeaveDialogOpen.value = false;
  }

  async function confirmLeaveChat() {
    if (!props.chat) return;
    isLeavingChat.value = true;
    try {
      await leaveChat(props.chat);
      // Back to the empty chat layout — the chat we just left no
      // longer matches anything in `sortedChats`, so leaving the
      // route on /chat/<channel> would just show the not-found state.
      router.push({ name: "home" });
      isLeaveDialogOpen.value = false;
    } finally {
      isLeavingChat.value = false;
    }
  }

  return {
    session,
    isOwner,
    newMemberHandle,
    isAddingMember,
    addMemberError,
    addUserToChat,
    isLeaveDialogOpen,
    isLeavingChat,
    requestLeaveChat,
    cancelLeaveChat,
    confirmLeaveChat,
    displayHandle,
  };
}

export default async () => {
  ensureStylesheet();
  return {
    // The active chat is always rendered by the parent's chat layout,
    // so the panel takes it as a prop instead of re-deriving it from
    // the route. This keeps the component pure(r) and means it can be
    // dropped into any future view that has a chat object handy.
    props: {
      chat: { type: Object, default: null },
    },
    setup,
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
      r.text(),
    ),
  };
};
