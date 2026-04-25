import { createApp, ref, computed, watch } from "vue";
import {
  createRouter,
  createWebHashHistory,
  useRoute,
  useRouter,
} from "vue-router";
import { GraffitiLocal } from "@graffiti-garden/implementation-local";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import { GraffitiPlugin } from "@graffiti-garden/wrapper-vue";
import {
  useSharedChatData,
  displayHandle,
  buildMonthGrid,
  WEEKDAY_LABELS,
} from "./sharedChatData.js";

// Lazy-load a route component from `./<name>/chat.js`. Each subfolder
// exports an async default that returns a component options object
// with its own setup + template. Following the studio11-starter
// pattern: the page-specific code (calendar, sorted) only ships to
// the browser when the user actually navigates there.
function loadComponent(name) {
  return () => import(`./${name}/chat.js`).then((m) => m.default());
}

function setup() {
  const route = useRoute();
  const router = useRouter();

  // All Graffiti discoveries, derived state, and mutations live in
  // sharedChatData so the calendar and sorted routes can reuse the
  // exact same streams without spinning up duplicate queries. We
  // call the composable here (in the root App's setup) so the
  // module-singleton initializes once, while we still have a Vue
  // component instance for the underlying `inject` calls.
  const {
    session,
    chats,
    sortedChats,
    areChatsLoading,
    laterObjects,
    allMessageObjects,
    areAllMessagesLoading,
    latestMessageByChannel,
    lastReadByChannel,
    hasUnread,
    isLater,
    markChatAsLater: postLater,
    clearLater: postClearLater,
    markChatAsRead,
    scheduleLater,
    createChat: postCreateChat,
    sendMessageToChat,
    addMemberToChat,
    leaveChat,
    deleteObject,
  } = useSharedChatData();

  // The random channel of the chat the user has currently opened.
  //
  // We derive it from the URL (e.g. /#/chat/<channel>) instead of holding
  // it as a plain ref so that each chat has its own permalink: deep
  // links work, the back button works, and "share this chat" is just
  // "copy the URL". The route is the single source of truth for which
  // chat is active — every other piece of state (active chat, members,
  // messages) is computed from it.
  const activeChannel = computed(() => {
    if (route.name !== "chat") return null;
    const param = route.params.channel;
    const value = Array.isArray(param) ? param[0] : param;
    return value || null;
  });

  // True when the chat layout (sidebar + chat window) should be shown.
  // The calendar and sorted views are mounted via <router-view> when
  // this is false. Driven by the route name so the back/forward
  // buttons and deep links Just Work.
  const isChatView = computed(
    () => route.name === "home" || route.name === "chat",
  );

  // ---- Page-local form / busy state ---------------------------------
  //
  // These belong to the chat view, not to the shared composable: they
  // describe what the *currently visible chat UI* is doing right now,
  // which is meaningless when the user is on /#/calendar or
  // /#/sorted.

  const newChatTitle = ref("");
  const isCreatingChat = ref(false);

  const newMemberHandle = ref("");
  const isAddingMember = ref(false);
  const addMemberError = ref("");

  const myMessage = ref("");
  const isSending = ref(false);
  const isMarkingLater = ref(false);
  const isDeleting = ref(new Set());

  const isLeaveDialogOpen = ref(false);
  const isLeavingChat = ref(false);

  // ---- Sidebar nav --------------------------------------------------

  function openCalendar() {
    router.push({ name: "calendar" });
  }

  function openSorted() {
    router.push({ name: "sorted" });
  }

  // ---- Schedule modal state -----------------------------------------
  //
  // The schedule flow is two stages: pick a date, then pick a time.
  // We keep them as separate steps (rather than one combined picker)
  // because the calendar grid takes up most of the modal real estate
  // and the time input deserves a clean focus state. `scheduleStep`
  // is "date" or "time".
  const isScheduleDialogOpen = ref(false);
  const scheduleStep = ref("date");
  const scheduleDate = ref(new Date());
  const scheduleTime = ref("12:00");
  const isScheduling = ref(false);

  // Default the time to the next round hour from now (e.g. 14:00 if
  // it's currently 13:42). Picked because the most common use case is
  // "remind me a bit later today" rather than "remind me right now".
  function defaultScheduleTime() {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // Mini-calendar for the schedule picker.
  const scheduleMonthGrid = computed(() => buildMonthGrid(scheduleDate.value));

  const scheduleMonthTitle = computed(() =>
    scheduleDate.value.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  );

  // Pretty label for the chosen date, shown above the time input on
  // step 2 ("Reply on Friday, May 1") so the user has context about
  // what they're scheduling without having to glance at the back button.
  const pickedDateLabel = computed(() =>
    scheduleDate.value.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );

  function openScheduleDialog() {
    if (!activeChat.value) return;
    scheduleStep.value = "date";
    scheduleDate.value = new Date();
    scheduleTime.value = defaultScheduleTime();
    isScheduleDialogOpen.value = true;
  }

  function cancelSchedule() {
    if (isScheduling.value) return;
    isScheduleDialogOpen.value = false;
  }

  function pickScheduleDate(cell) {
    scheduleDate.value = new Date(cell.date);
    scheduleStep.value = "time";
  }

  function backToScheduleDate() {
    if (isScheduling.value) return;
    scheduleStep.value = "date";
  }

  function scheduleStepPrevMonth() {
    const d = new Date(scheduleDate.value);
    d.setMonth(d.getMonth() - 1);
    scheduleDate.value = d;
  }

  function scheduleStepNextMonth() {
    const d = new Date(scheduleDate.value);
    d.setMonth(d.getMonth() + 1);
    scheduleDate.value = d;
  }

  // ---- Soft-delete + undo state -------------------------------------
  //
  // Per-chat-view UX: hiding a deleted message immediately while
  // letting the user undo it within a window. The actual
  // graffiti.delete only runs once the timer expires, because Graffiti
  // forbids re-putting a deleted object (see graffiti.md "delete" /
  // "right to be forgotten") so we can't reverse a real delete by
  // re-posting.

  const UNDO_DELETE_MS = 10000;
  const pendingDeletes = ref(new Map());

  // ---- Active-chat derived state ------------------------------------
  //
  // Everything below derives from the active route + the shared
  // streams. Kept in chat.js (not shared) because "which chat is
  // active" is a chat-view concept; the calendar and sorted views
  // never have an active chat.

  const activeChat = computed(() => {
    if (!activeChannel.value) return null;
    return (
      chats.value.find((c) => c.value.channel === activeChannel.value) ?? null
    );
  });

  // True if the logged-in user created the active chat. Only the creator
  // can add members, because adding requires deleting the old chat object
  // and re-posting with an updated allowed list — and only the creator is
  // permitted to delete their own object.
  const isActiveChatOwner = computed(
    () =>
      !!activeChat.value &&
      !!session.value &&
      activeChat.value.actor === session.value.actor,
  );

  const isActiveChatLater = computed(
    () => !!activeChat.value && isLater(activeChat.value),
  );

  // Messages for just the currently open chat, derived from the
  // shared all-chats stream. Each message is posted in exactly one
  // channel (the chat's channel), and that channel is visible on the
  // returned object even for non-creators because we explicitly
  // queried for it.
  const messageObjects = computed(() => {
    if (!activeChat.value) return [];
    const channel = activeChat.value.value.channel;
    return allMessageObjects.value.filter((m) =>
      (m.channels ?? []).includes(channel),
    );
  });

  // Treat "still loading messages" as the all-chats poll not having
  // completed yet OR the chat list itself still loading.
  const areMessagesLoading = computed(
    () => areChatsLoading.value || areAllMessagesLoading.value,
  );

  // Most recent `scheduledFor` for the active chat, if any. Drives the
  // "Scheduled for ..." label on the chip in the chat header. We take
  // the max so a freshly written marker always wins over a stale one
  // that hasn't been deleted yet.
  const activeScheduledFor = computed(() => {
    if (!activeChat.value) return null;
    const channel = activeChat.value.value.channel;
    let best = null;
    for (const o of laterObjects.value) {
      if (o.value.target !== channel) continue;
      if (typeof o.value.scheduledFor !== "number") continue;
      if (best === null || o.value.scheduledFor > best) {
        best = o.value.scheduledFor;
      }
    }
    return best;
  });

  const activeScheduledLabel = computed(() => {
    if (activeScheduledFor.value === null) return null;
    return new Date(activeScheduledFor.value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  });

  // True once we know for sure the URL points at a chat the user can't
  // see. Two cases collapse into one here on purpose:
  //   * the chat genuinely doesn't exist
  //   * the chat exists but the user isn't on its allowed list
  // We can't distinguish those with the discover API (and shouldn't —
  // exposing "this chat exists, you just can't see it" would itself be
  // a leak), so we treat both as "not found". We also wait for the
  // first chats poll to complete before declaring "missing", otherwise
  // every page load would briefly flash a not-found message before the
  // chat list arrives.
  const isActiveChatMissing = computed(() => {
    if (!activeChannel.value) return false;
    if (!session.value) return false;
    if (areChatsLoading.value) return false;
    return !activeChat.value;
  });

  // Oldest at the top, newest at the bottom (chat-app convention).
  // Hide messages whose delete is pending so the UI feels deleted while
  // the 10-second undo window is open.
  const sortedMessages = computed(() =>
    messageObjects.value
      .filter((m) => !pendingDeletes.value.has(m.url))
      .toSorted((a, b) => a.value.published - b.value.published),
  );

  // Toast list — one entry per pending-delete so we can show a stack of
  // undo prompts if the user deletes multiple messages quickly.
  const pendingDeleteList = computed(() =>
    Array.from(pendingDeletes.value.values()),
  );

  // ---- Auto read-marker watcher -------------------------------------
  //
  // Whenever the user has a chat open AND there are messages newer
  // than their last read marker for it, post a fresh read marker.
  // This covers two cases at once:
  //   * opening a chat that has unread messages
  //   * receiving a new message while the chat is already open
  // The watch re-fires after the marker is posted, but by then
  // `lastRead >= latestMsg` so we no-op and avoid an infinite loop.
  // The watcher lives in chat.js (not the shared composable) because
  // it depends on the chat view's notion of "active chat" — the
  // calendar and sorted views shouldn't be marking anything as read.
  watch(
    [
      activeChannel,
      () => latestMessageByChannel.value.get(activeChannel.value),
      () => lastReadByChannel.value.get(activeChannel.value),
      areAllMessagesLoading,
    ],
    ([channel, latestMsg, lastRead, loading]) => {
      if (loading) return;
      if (!channel || !session.value) return;
      if (!latestMsg) return;
      if (latestMsg <= (lastRead ?? 0)) return;
      markChatAsRead(channel);
    },
    { immediate: true },
  );

  // ---- Active-chat-bound thin wrappers ------------------------------
  //
  // The shared module exposes channel-scoped functions so it doesn't
  // need to know what an "active chat" is. The template wires its
  // buttons to no-arg / minimal-arg handlers, so we wrap the shared
  // ops here to fish the channel out of `activeChat` and to set the
  // page-local busy flags.

  function selectChat(chat) {
    router.push({ name: "chat", params: { channel: chat.value.channel } });
    addMemberError.value = "";
    newMemberHandle.value = "";
  }

  async function createChat() {
    if (!session.value || !newChatTitle.value.trim()) return;
    isCreatingChat.value = true;
    try {
      const channel = await postCreateChat(newChatTitle.value);
      if (channel) {
        newChatTitle.value = "";
        router.push({ name: "chat", params: { channel } });
      }
    } finally {
      isCreatingChat.value = false;
    }
  }

  async function markChatAsLater() {
    if (!activeChat.value) return;
    isMarkingLater.value = true;
    try {
      await postLater(activeChat.value.value.channel);
    } finally {
      isMarkingLater.value = false;
    }
  }

  // Re-exposed under the same name the template uses; the shared
  // version takes a channel arg, so the template's
  // `clearLater(activeChat.value.channel)` call passes through
  // unchanged.
  const clearLater = postClearLater;

  async function confirmSchedule() {
    if (!activeChat.value || !scheduleTime.value) return;
    const [hours, minutes] = scheduleTime.value.split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return;

    const when = new Date(scheduleDate.value);
    when.setHours(hours, minutes, 0, 0);

    isScheduling.value = true;
    try {
      await scheduleLater(activeChat.value.value.channel, when.getTime());
      isScheduleDialogOpen.value = false;
    } finally {
      isScheduling.value = false;
    }
  }

  async function addUserToChat() {
    addMemberError.value = "";
    if (!activeChat.value) return;
    const handle = newMemberHandle.value.trim();
    if (!handle) return;

    isAddingMember.value = true;
    try {
      await addMemberToChat(activeChat.value, handle);
      newMemberHandle.value = "";
    } catch (err) {
      addMemberError.value = err?.message ?? "Could not add that user.";
    } finally {
      isAddingMember.value = false;
    }
  }

  function requestLeaveChat() {
    if (!activeChat.value) return;
    isLeaveDialogOpen.value = true;
  }

  function cancelLeaveChat() {
    if (isLeavingChat.value) return;
    isLeaveDialogOpen.value = false;
  }

  async function confirmLeaveChat() {
    if (!activeChat.value) return;
    isLeavingChat.value = true;
    try {
      await leaveChat(activeChat.value);
      router.push({ name: "home" });
      isLeaveDialogOpen.value = false;
    } finally {
      isLeavingChat.value = false;
    }
  }

  async function sendMessage() {
    if (!activeChat.value) return;
    const text = myMessage.value.trim();
    if (!text) return;

    isSending.value = true;
    try {
      await sendMessageToChat(activeChat.value, text);
      myMessage.value = "";
    } finally {
      isSending.value = false;
    }
  }

  // ---- Soft-delete helpers ------------------------------------------
  //
  // "Soft" delete a message: hide it from the UI immediately and start
  // a 10-second timer. If the user clicks Undo before the timer fires,
  // we cancel the timer and the message reappears. Otherwise the
  // actual graffiti.delete runs and the message is gone for good.
  function deleteMessage(message) {
    if (pendingDeletes.value.has(message.url)) return;

    const startedAt = Date.now();
    const timeoutId = setTimeout(
      () => commitDelete(message.url),
      UNDO_DELETE_MS,
    );

    const next = new Map(pendingDeletes.value);
    next.set(message.url, {
      url: message.url,
      message,
      timeoutId,
      startedAt,
      expiresAt: startedAt + UNDO_DELETE_MS,
    });
    pendingDeletes.value = next;
  }

  function undoDelete(url) {
    const entry = pendingDeletes.value.get(url);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    const next = new Map(pendingDeletes.value);
    next.delete(url);
    pendingDeletes.value = next;
  }

  async function commitDelete(url) {
    const entry = pendingDeletes.value.get(url);
    if (!entry) return;

    const next = new Map(pendingDeletes.value);
    next.delete(url);
    pendingDeletes.value = next;

    isDeleting.value.add(url);
    try {
      await deleteObject(url);
    } finally {
      isDeleting.value.delete(url);
    }
  }

  return {
    newChatTitle,
    isCreatingChat,
    createChat,
    chats,
    sortedChats,
    areChatsLoading,
    activeChannel,
    activeChat,
    isActiveChatMissing,
    selectChat,
    isActiveChatOwner,
    newMemberHandle,
    isAddingMember,
    addMemberError,
    addUserToChat,
    myMessage,
    isSending,
    sendMessage,
    isDeleting,
    deleteMessage,
    sortedMessages,
    areMessagesLoading,
    pendingDeletes,
    pendingDeleteList,
    undoDelete,
    UNDO_DELETE_MS,
    isLeaveDialogOpen,
    isLeavingChat,
    requestLeaveChat,
    cancelLeaveChat,
    confirmLeaveChat,
    displayHandle,
    hasUnread,
    isLater,
    isActiveChatLater,
    isMarkingLater,
    markChatAsLater,
    clearLater,
    isChatView,
    weekdayLabels: WEEKDAY_LABELS,
    openCalendar,
    openSorted,
    activeScheduledFor,
    activeScheduledLabel,
    isScheduleDialogOpen,
    scheduleStep,
    scheduleDate,
    scheduleTime,
    isScheduling,
    scheduleMonthGrid,
    scheduleMonthTitle,
    pickedDateLabel,
    openScheduleDialog,
    cancelSchedule,
    pickScheduleDate,
    backToScheduleDate,
    scheduleStepPrevMonth,
    scheduleStepNextMonth,
    confirmSchedule,
  };
}

const App = { template: "#template", setup };

// Routes:
//   /                  empty home (no chat selected, chat layout shows
//                      sidebar + a "select a chat" placeholder)
//   /chat/:channel     a specific chat (chat layout, that chat active)
//   /calendar          calendar view, lazy-loaded from ./calendar/chat.js
//   /sorted            kanban view, lazy-loaded from ./sorted/chat.js
//
// The home and chat routes use stub components because the chat layout
// is rendered directly by the root App via `isChatView`. The calendar
// and sorted routes resolve to the real components those folders
// export, mounted by <router-view> when isChatView flips to false.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: { template: "<div></div>" } },
    {
      path: "/chat/:channel",
      name: "chat",
      component: { template: "<div></div>" },
    },
    {
      path: "/calendar",
      name: "calendar",
      component: loadComponent("calendar"),
    },
    {
      path: "/sorted",
      name: "sorted",
      component: loadComponent("sorted"),
    },
  ],
});

createApp(App)
  .use(router)
  .use(GraffitiPlugin, {
    graffiti: new GraffitiDecentralized(),
  })
  .mount("#app");
