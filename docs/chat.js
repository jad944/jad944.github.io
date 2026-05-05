import {
  createApp,
  ref,
  computed,
  watch,
  nextTick,
  defineAsyncComponent,
} from "vue";
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
    recentChats,
    otherChats,
    areChatsLoading,
    laterObjects,
    laterMessageUrls,
    laterCountByChannel,
    allMessageObjects,
    areAllMessagesLoading,
    latestMessageByChannel,
    lastReadByChannel,
    hasUnread,
    isLater,
    markMessageAsLater: postMarkMessageAsLater,
    clearMessageLater: postClearMessageLater,
    markChatAsRead,
    scheduleLater,
    createChat: postCreateChat,
    sendMessageToChat,
    addMemberToChat,
    leaveChat,
    deleteObject,
    scheduledSendObjects,
    createScheduledSend: postCreateScheduledSend,
    executeScheduledSend: postExecuteScheduledSend,
  } = useSharedChatData();

  // ---- Tab Notifications for Past-Due Scheduled Messages ----
  const currentTime = ref(Date.now());
  setInterval(() => {
    currentTime.value = Date.now();
  }, 10000);

  const pastDueNotificationsCount = computed(() => {
    let count = 0;
    for (const o of laterObjects.value) {
      if (typeof o.value.scheduledFor === "number" && o.value.scheduledFor <= currentTime.value) {
        count++;
      }
    }
    for (const o of scheduledSendObjects.value) {
      if (typeof o.value.scheduledFor === "number" && o.value.scheduledFor <= currentTime.value) {
        count++;
      }
    }
    return count;
  });

  watch(pastDueNotificationsCount, (count) => {
    if (count > 0) {
      document.title = `🔴 (${count}) Reply Now`;
    } else {
      document.title = "Chat App";
    }
  }, { immediate: true });

  // ---- Auto-send timer for scheduled sends --------------------------
  //
  // When a ScheduleSend marker's `scheduledFor` passes, we
  // automatically execute the send. A Set tracks URLs currently
  // in-flight so concurrent ticks don't fire duplicate sends.
  const scheduledSendInFlight = ref(new Set());

  watch(
    [() => scheduledSendObjects.value, currentTime],
    async () => {
      for (const sendObj of scheduledSendObjects.value) {
        const when = sendObj.value.scheduledFor;
        if (typeof when !== "number") continue;
        if (when > currentTime.value) continue;
        if (scheduledSendInFlight.value.has(sendObj.url)) continue;
        scheduledSendInFlight.value.add(sendObj.url);
        try {
          await postExecuteScheduledSend(sendObj);
        } finally {
          scheduledSendInFlight.value.delete(sendObj.url);
        }
      }
    },
    { immediate: true },
  );

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

  const isMobile = ref(window.innerWidth <= 768);
  const isSidebarCollapsed = ref(false);
  const isChatWindowCollapsed = ref(false);

  window.addEventListener('resize', () => {
    const nowMobile = window.innerWidth <= 768;
    if (nowMobile !== isMobile.value) {
      isMobile.value = nowMobile;
      if (nowMobile) {
        if (activeChannel.value) {
          isSidebarCollapsed.value = true;
          isChatWindowCollapsed.value = false;
        } else {
          isSidebarCollapsed.value = false;
          isChatWindowCollapsed.value = true;
        }
      } else {
        isSidebarCollapsed.value = false;
        isChatWindowCollapsed.value = false;
      }
    }
  });

  function toggleSidebar() {
    isSidebarCollapsed.value = !isSidebarCollapsed.value;
    if (isMobile.value && !isSidebarCollapsed.value) {
      isChatWindowCollapsed.value = true;
    } else if (isSidebarCollapsed.value && isChatWindowCollapsed.value) {
      isChatWindowCollapsed.value = false;
    }
  }

  function toggleChatWindow() {
    isChatWindowCollapsed.value = !isChatWindowCollapsed.value;
    if (isMobile.value && !isChatWindowCollapsed.value) {
      isSidebarCollapsed.value = true;
    } else if (isChatWindowCollapsed.value && isSidebarCollapsed.value) {
      isSidebarCollapsed.value = false;
    }
  }

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
  // Errors from the add-user form are ephemeral feedback, not durable
  // state, so they auto-dismiss after a short window. We hold the
  // active timer on the side so a brand-new query (or a chat switch)
  // can cancel a still-pending dismissal — otherwise an old timer
  // would race with the new error and clear it early.
  const ADD_MEMBER_ERROR_MS = 5000;
  let addMemberErrorTimer = null;

  function clearAddMemberError() {
    if (addMemberErrorTimer !== null) {
      clearTimeout(addMemberErrorTimer);
      addMemberErrorTimer = null;
    }
    addMemberError.value = "";
  }

  function setAddMemberError(message) {
    if (addMemberErrorTimer !== null) {
      clearTimeout(addMemberErrorTimer);
    }
    addMemberError.value = message;
    addMemberErrorTimer = setTimeout(() => {
      addMemberError.value = "";
      addMemberErrorTimer = null;
    }, ADD_MEMBER_ERROR_MS);
  }

  const myMessage = ref("");
  const isSending = ref(false);
  const isMarkingLater = ref(false);
  const isUnmarkingLater = ref(false);
  const isDeleting = ref(new Set());

  // ---- Reply-to-message state ----------------------------------------
  //
  // The message the user is composing a reply to, or null. Set by
  // startReply (triggered from the hover reply button on each message)
  // and cleared by cancelReply, sendMessage, or switching chats.
  const replyingTo = ref(null);

  const isLeaveDialogOpen = ref(false);
  const isLeavingChat = ref(false);

  // ---- Message selection (long-press) --------------------------------
  //
  // Users long-press (500ms) a message to select it. The selection
  // bubble (a checkmark) pops to the left for received messages or
  // the right for sent messages. Clicking anywhere else deselects.
  // While a message is selected, the Reply Later and Schedule buttons
  // in the sidebar footer act on that message instead of the chat.

  const selectedMessage = ref(null);
  let longPressTimer = null;
  const LONG_PRESS_MS = 500;

  function onMessagePressStart(message, event) {
    // Prevent text selection during long press
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      selectedMessage.value = message;
      // Prevent the click-to-deselect from immediately firing
      event?.preventDefault?.();
    }, LONG_PRESS_MS);
  }

  function onMessagePressEnd() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onMessagePressCancel() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function deselectMessage() {
    selectedMessage.value = null;
  }

  function isMessageSelected(message) {
    return selectedMessage.value?.url === message.url;
  }

  function isMessageLater(message) {
    return laterMessageUrls.value.has(message.url);
  }

  // ---- Reply helpers -------------------------------------------------

  function startReply(message) {
    replyingTo.value = message;
    // Focus the compose input so the user can start typing immediately.
    nextTick(() => {
      const input = document.getElementById("message-input");
      if (input) input.focus();
    });
  }

  function cancelReply() {
    replyingTo.value = null;
  }

  // Look up a message object by its Graffiti URL. Used by the reply
  // indicator to show the author of the original message.
  function getMessageByUrl(url) {
    if (!url) return null;
    return sortedMessages.value.find((m) => m.url === url) ?? null;
  }

  // Scroll to a message by URL and briefly flash-highlight it.
  function scrollToMessage(url) {
    if (!url) return;
    const list = document.getElementById("message-list");
    if (!list) return;
    // Messages are rendered with :key="message.url" so Vue keyed
    // <li>s can be located by walking the sortedMessages index.
    const idx = sortedMessages.value.findIndex((m) => m.url === url);
    if (idx === -1) return;
    const li = list.children[idx];
    if (!li) return;
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    li.classList.add("reply-flash");
    setTimeout(() => li.classList.remove("reply-flash"), 1200);
  }

  // ---- Messages auto-scroll -----------------------------------------
  //
  // Standard chat-app behavior: opening a chat snaps to the latest
  // message, and new messages keep following the bottom — unless the
  // user has scrolled up to read history, in which case incoming
  // messages stay out of their way until they scroll back down.
  //
  // `pinnedToBottom` is the single source of truth for "should new
  // content drag the viewport with it?". It is recomputed every time
  // the user scrolls (engaging the scroll bar at all immediately
  // unsets it once the offset crosses the threshold, so the override
  // sticks even when the user lets go and stops scrolling). The
  // threshold gives subpixel rendering and the reaction chips that
  // hang ~9px below the last bubble a little headroom so the user
  // doesn't accidentally fall out of "pinned" by a few stray pixels.

  const messagesEl = ref(null);
  const pinnedToBottom = ref(true);
  const PIN_THRESHOLD_PX = 24;

  function scrollMessagesToBottom() {
    const el = messagesEl.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function onMessagesScroll() {
    const el = messagesEl.value;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    pinnedToBottom.value = distFromBottom <= PIN_THRESHOLD_PX;
  }

  // The two watchers that drive the actual scrolling (activeChannel and
  // sortedMessages.length) are registered further down, right after
  // `sortedMessages` is defined — they have to be, because watch()
  // evaluates its source on registration.

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
    if (!activeChat.value || !selectedMessage.value) return;
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

  // ---- Schedule Send modal state ------------------------------------
  //
  // Parallel to the "Remind Me to Reply" schedule modal, but for
  // queuing a message to be auto-sent at a future time. Reuses
  // the same calendar + time-picker two-step pattern.
  const isScheduleSendDialogOpen = ref(false);
  const scheduleSendStep = ref("date");
  const scheduleSendDate = ref(new Date());
  const scheduleSendTime = ref("12:00");
  const isScheduleSending = ref(false);

  const scheduleSendMonthGrid = computed(() =>
    buildMonthGrid(scheduleSendDate.value),
  );

  const scheduleSendMonthTitle = computed(() =>
    scheduleSendDate.value.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  );

  const scheduleSendPickedDateLabel = computed(() =>
    scheduleSendDate.value.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );

  function openScheduleSendDialog() {
    if (!activeChat.value) return;
    if (!myMessage.value.trim()) return;
    scheduleSendStep.value = "date";
    scheduleSendDate.value = new Date();
    scheduleSendTime.value = defaultScheduleTime();
    isScheduleSendDialogOpen.value = true;
  }

  function cancelScheduleSend() {
    if (isScheduleSending.value) return;
    isScheduleSendDialogOpen.value = false;
  }

  function pickScheduleSendDate(cell) {
    scheduleSendDate.value = new Date(cell.date);
    scheduleSendStep.value = "time";
  }

  function backToScheduleSendDate() {
    if (isScheduleSending.value) return;
    scheduleSendStep.value = "date";
  }

  function scheduleSendStepPrevMonth() {
    const d = new Date(scheduleSendDate.value);
    d.setMonth(d.getMonth() - 1);
    scheduleSendDate.value = d;
  }

  function scheduleSendStepNextMonth() {
    const d = new Date(scheduleSendDate.value);
    d.setMonth(d.getMonth() + 1);
    scheduleSendDate.value = d;
  }

  async function confirmScheduleSend() {
    if (!activeChat.value || !scheduleSendTime.value) return;
    const text = myMessage.value.trim();
    if (!text) return;
    const [hours, minutes] = scheduleSendTime.value.split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return;

    const when = new Date(scheduleSendDate.value);
    when.setHours(hours, minutes, 0, 0);

    isScheduleSending.value = true;
    try {
      const channel = activeChat.value.value.channel;
      await postCreateScheduledSend(channel, text, when.getTime());
      myMessage.value = "";
      isScheduleSendDialogOpen.value = false;
    } finally {
      isScheduleSending.value = false;
    }
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

  // Count of messages marked later in the active chat. Drives the
  // "# Messages to Reply to Later" header chip.
  const activeChatLaterCount = computed(() => {
    if (!activeChat.value) return 0;
    return laterCountByChannel.value.get(activeChat.value.value.channel) ?? 0;
  });

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

  // ---- Auto-scroll watchers -----------------------------------------
  //
  // Registered down here (not next to the helpers above) because watch
  // evaluates its source eagerly and `sortedMessages` only exists from
  // this point on.

  // Switching chats always re-pins and snaps to the bottom. Done as a
  // watcher (with immediate:true) rather than only inside selectChat()
  // so the behavior also fires on direct navigation — deep links, the
  // browser back/forward buttons, and the initial page load.
  watch(
    activeChannel,
    async () => {
      pinnedToBottom.value = true;
      await nextTick();
      scrollMessagesToBottom();
    },
    { immediate: true },
  );

  // Drop any stale add-member error when the user changes chats.
  // addMemberError lives at the App scope (one ref shared across
  // every chat's add-member form), so without this it would visibly
  // leak from the chat where it was raised into whichever chat the
  // user navigates to next. The sidebar uses <router-link> rather
  // than calling selectChat(), so the route change — not a click
  // handler — is the authoritative signal that "the user moved on".
  // No immediate:true: the error starts empty on mount, so there's
  // nothing to clear before the first navigation.
  watch(activeChannel, (newVal) => {
    clearAddMemberError();
    deselectMessage();
    cancelReply();

    if (newVal) {
      if (isMobile.value) {
        isSidebarCollapsed.value = true;
      }
      isChatWindowCollapsed.value = false;
    } else {
      if (isMobile.value) {
        isSidebarCollapsed.value = false;
        isChatWindowCollapsed.value = true;
      }
    }
  }, { immediate: true });

  // New messages (or a soft-deleted message disappearing) only pull
  // the viewport down when the user is currently following the
  // conversation. Watching the length keeps this cheap; the actual
  // scroll waits for nextTick so the new bubble is in the layout.
  // When messages are still streaming in for a freshly-opened chat
  // (areMessagesLoading flickers), the activeChannel watcher above
  // has already left pinnedToBottom = true, so this naturally walks
  // the viewport down as each batch arrives.
  watch(
    () => sortedMessages.value.length,
    async () => {
      if (!pinnedToBottom.value) return;
      await nextTick();
      scrollMessagesToBottom();
    },
  );

  watch(
    [() => route.query.animateMessage, areMessagesLoading],
    async ([animateMessageUrl, loading]) => {
      if (!animateMessageUrl || loading) return;

      // Wait for DOM to update with messages
      await nextTick();

      const msg = sortedMessages.value.find(m => m.url === animateMessageUrl);
      if (!msg) return;

      const isMine = session.value && msg.actor === session.value.actor;
      const list = document.getElementById("message-list");
      if (!list) return;

      const idx = sortedMessages.value.findIndex((m) => m.url === animateMessageUrl);
      if (idx === -1) return;
      const li = list.children[idx];
      if (!li) return;

      // Briefly scroll to the animated message
      li.scrollIntoView({ behavior: "smooth", block: "center" });

      // Animate it
      const animationClass = isMine ? "bounce-left-to-right" : "bounce-right-to-left";
      li.classList.add(animationClass);

      // Remove class after animation completes
      setTimeout(() => {
        li.classList.remove(animationClass);
      }, 1000);
    },
    { immediate: true }
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
    clearAddMemberError();
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

  // Toggle the later state of the currently selected message.
  // If the message is already marked, clicking Reply Later again
  // clears it (no separate dismiss button needed).
  async function toggleMessageLater() {
    if (!activeChat.value || !selectedMessage.value) return;
    const msg = selectedMessage.value;
    if (laterMessageUrls.value.has(msg.url)) {
      isUnmarkingLater.value = true;
      try {
        await postClearMessageLater(msg.url);
      } finally {
        isUnmarkingLater.value = false;
      }
    } else {
      isMarkingLater.value = true;
      try {
        const channel = activeChat.value.value.channel;
        const preview = msg.value.content ?? "";
        await postMarkMessageAsLater(msg.url, channel, preview);
      } finally {
        isMarkingLater.value = false;
      }
    }
    deselectMessage();
  }

  async function confirmSchedule() {
    if (!activeChat.value || !selectedMessage.value || !scheduleTime.value) return;
    const [hours, minutes] = scheduleTime.value.split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return;

    const when = new Date(scheduleDate.value);
    when.setHours(hours, minutes, 0, 0);

    isScheduling.value = true;
    try {
      const msg = selectedMessage.value;
      const channel = activeChat.value.value.channel;
      const preview = msg.value.content ?? "";
      await scheduleLater(msg.url, channel, preview, when.getTime());
      isScheduleDialogOpen.value = false;
      deselectMessage();
    } finally {
      isScheduling.value = false;
    }
  }

  async function addUserToChat() {
    // Submitting a new query always wipes the prior error first so
    // there's no stale message lingering while we wait on the lookup,
    // and so a slow response can't be undercut by an old auto-dismiss
    // timer. The new submit then either resolves silently (success)
    // or installs its own error with a fresh 5s timer below.
    clearAddMemberError();
    if (!activeChat.value) return;
    const handle = newMemberHandle.value.trim();
    if (!handle) return;

    isAddingMember.value = true;
    try {
      await addMemberToChat(activeChat.value, handle);
      newMemberHandle.value = "";
    } catch (err) {
      setAddMemberError(err?.message ?? "Could not add that user.");
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

    // Identify the last message before we send, so we can clear its
    // later marker if the user is replying directly after it.
    const lastMessage = sortedMessages.value.length > 0
      ? sortedMessages.value[sortedMessages.value.length - 1]
      : null;

    isSending.value = true;
    try {
      const inReplyTo = replyingTo.value?.url ?? null;
      await sendMessageToChat(activeChat.value, text, inReplyTo);

      if (
        lastMessage &&
        lastMessage.url !== inReplyTo &&
        laterMessageUrls.value.has(lastMessage.url)
      ) {
        await postClearMessageLater(lastMessage.url);
      }

      myMessage.value = "";
      replyingTo.value = null;
      // Sending is a deliberate re-engagement with the conversation,
      // so it overrides any previous "scrolled up to read history"
      // state — re-pin and snap, just like clicking on the chat. The
      // length watcher above will also fire, but only acts when
      // already pinned, so we set the pin first.
      pinnedToBottom.value = true;
      await nextTick();
      scrollMessagesToBottom();
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
    isSidebarCollapsed,
    isChatWindowCollapsed,
    toggleSidebar,
    toggleChatWindow,
    newChatTitle,
    isCreatingChat,
    createChat,
    chats,
    sortedChats,
    recentChats,
    otherChats,
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
    messagesEl,
    onMessagesScroll,
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
    activeChatLaterCount,
    isMarkingLater,
    isUnmarkingLater,
    toggleMessageLater,
    selectedMessage,
    onMessagePressStart,
    onMessagePressEnd,
    onMessagePressCancel,
    deselectMessage,
    isMessageSelected,
    isMessageLater,
    replyingTo,
    startReply,
    cancelReply,
    getMessageByUrl,
    scrollToMessage,
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
    isScheduleSendDialogOpen,
    scheduleSendStep,
    scheduleSendDate,
    scheduleSendTime,
    isScheduleSending,
    scheduleSendMonthGrid,
    scheduleSendMonthTitle,
    scheduleSendPickedDateLabel,
    openScheduleSendDialog,
    cancelScheduleSend,
    pickScheduleSendDate,
    backToScheduleSendDate,
    scheduleSendStepPrevMonth,
    scheduleSendStepNextMonth,
    confirmScheduleSend,
  };
}

// The Reaction component is reused on every message in the active
// chat. We register it globally on App.components (rather than as a
// route) because it lives *inside* a message bubble, not as its own
// page. Loaded via defineAsyncComponent so the JSON-schema /
// stylesheet payload doesn't block the chat's first paint — the
// chips just snap in once the module resolves.
const Reaction = defineAsyncComponent(async () => {
  const mod = await import("./reaction/chat.js");
  return await mod.default();
});

const App = {
  template: "#template",
  setup,
  components: { Reaction },
};

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
