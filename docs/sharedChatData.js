// Module-singleton composable that owns every Graffiti discovery and
// every cross-page derivation the chat / calendar / sorted views
// share. Each route component used to set up its own copies of these
// queries, which made navigating to /#/calendar or /#/sorted slow:
// the existing chat-view streams kept polling and the new component
// would spin up a second set from scratch. By initializing once and
// caching the result at module scope, the first page that mounts
// pays the discovery cost and every subsequent page just reuses the
// already-live refs.

import { computed, effectScope } from "vue";
import {
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";

// ---- Schemas --------------------------------------------------------
//
// JSON schemas describing every Graffiti object shape the app uses.
// Re-used both for discovery and as documentation of the object
// shape. We keep them at module scope (not inside the composable) so
// they're allocated exactly once for the page, not once per call.

// Chat-creation object.
//
// Note: we duplicate the member list inside `value.members` even though
// it mirrors the object's `allowed` list. This is because Graffiti
// masks the `allowed` list for non-creators (they only see
// themselves), so non-creator members would otherwise have no way to
// know who else is in the chat — which is needed to send messages
// everyone can see.
export const CHAT_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: [
        "activity",
        "type",
        "channel",
        "title",
        "published",
        "members",
      ],
      properties: {
        activity: { const: "Create" },
        type: { const: "Chat" },
        channel: { type: "string" },
        title: { type: "string" },
        published: { type: "number" },
        members: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
};

// Chat message object.
export const MESSAGE_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: ["activity", "type", "content", "published"],
      properties: {
        activity: { const: "Send" },
        type: { const: "Message" },
        content: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

// "Leave" marker. We use these so that a user who has left a chat can
// still hide it from their own view even when they're not the chat's
// creator and therefore can't modify the chat object's allowed list
// directly. Each Leave is posted privately in the leaving user's own
// inbox (allowed: []), with `target` set to the chat channel they
// left.
export const LEAVE_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: ["activity", "target"],
      properties: {
        activity: { const: "Leave" },
        target: { type: "string" },
      },
    },
  },
};

// Per-user "Later" marker. Posted privately in the user's own inbox
// (channels: [actor], allowed: []) with `target` = message URL,
// `targetChannel` = the chat channel the message belongs to, and
// `messagePreview` = a short snippet of the message text (for
// calendar/sorted display without needing to re-fetch the message).
//
// `scheduledFor` is optional: a plain Later marker omits it (free-form
// "when I get to it" reminder), while a Schedule marker sets it to a
// concrete UTC millisecond timestamp. We keep both flavors in the
// same schema so the dismissal/cleanup paths and the sidebar's Later
// dot don't need a second discovery query — a scheduled marker is
// just a later marker with a deadline attached.
export const LATER_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: ["activity", "target", "targetChannel", "messagePreview", "published"],
      properties: {
        activity: { const: "Later" },
        target: { type: "string" },
        targetChannel: { type: "string" },
        messagePreview: { type: "string" },
        published: { type: "number" },
        scheduledFor: { type: "number" },
      },
    },
  },
};

// Per-user "ScheduleSend" marker. Posted privately in the user's own
// inbox (channels: [actor], allowed: []) with `content` = the message
// text to be sent, `targetChannel` = the chat's random channel, and
// `scheduledFor` = the UTC-ms timestamp at which the message should
// be delivered. When the scheduled time arrives, the app auto-sends
// the message via `sendMessageToChat` and deletes this marker.
export const SCHEDULED_SEND_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: [
        "activity",
        "type",
        "content",
        "targetChannel",
        "scheduledFor",
        "published",
      ],
      properties: {
        activity: { const: "ScheduleSend" },
        type: { const: "ScheduledMessage" },
        content: { type: "string" },
        targetChannel: { type: "string" },
        scheduledFor: { type: "number" },
        published: { type: "number" },
      },
    },
  },
};

// Reaction object. Posted once per (actor, message, emoji) combination
// in the chat's own random channel so every chat member's reaction
// discovery picks it up. The reaction's `target` is the URL of the
// message it's reacting to; its `emoji` is one of the small fixed set
// the picker offers ("heart", "thumbsup", "smiley"). Stacking is
// derived from how many distinct actors used the same emoji on the
// same message — we never write a multi-count reaction object.
export const REACTION_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: ["activity", "type", "target", "emoji", "published"],
      properties: {
        activity: { const: "React" },
        type: { const: "Reaction" },
        target: { type: "string" },
        emoji: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

// Per-user "Read" marker. Records the latest moment the user observed
// messages in a particular chat (`target` = chat channel, `lastReadAt`
// = timestamp). We treat the *highest* lastReadAt for each chat as
// the authoritative value, which lets us avoid having to delete
// prior markers; old ones are just ignored.
export const READ_SCHEMA = {
  properties: {
    value: {
      type: "object",
      required: ["activity", "target", "lastReadAt"],
      properties: {
        activity: { const: "Read" },
        target: { type: "string" },
        lastReadAt: { type: "number" },
      },
    },
  },
};

// ---- Display utilities ----------------------------------------------
//
// Pure functions used directly from templates and component setups.
// Pulling them up here means each route doesn't need its own copy.

// Graffiti handles look like "username.graffiti.actor". The suffix is
// an implementation detail of the handle namespace and is noise to
// end users, so we strip it everywhere we display a handle and
// re-attach it (if the user didn't type it) when resolving a handle
// back into an actor URI.
export const HANDLE_SUFFIX = ".graffiti.actor";

export function displayHandle(handle) {
  if (handle === undefined) return "Loading...";
  if (handle === null) return "Unknown user";
  return handle.endsWith(HANDLE_SUFFIX)
    ? handle.slice(0, -HANDLE_SUFFIX.length)
    : handle;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Locale-aware short time string ("9:30 AM"). Used by calendar event
// chips and the chat header's scheduled-reply indicator.
export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Compact "Apr 25, 4:30 PM"-style label for scheduled cards on the
// sorted board. Mirrors the chat header chip wording.
export function formatScheduledLabel(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// True if `a` and `b` fall on the same calendar day (local time).
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// YYYY-MM-DD key in *local* time. Deliberately not toISOString()
// (which is UTC) because a scheduled reminder set for late evening
// in the user's timezone could otherwise land in the wrong day's
// bucket on the calendar.
export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 6×7 day cells used by both the main calendar view and the schedule
// modal's mini-calendar. Always 6 rows so the grid height never
// jumps when stepping between months — small visual nicety, big
// consistency win.
export function buildMonthGrid(focal, today = new Date()) {
  const year = focal.getFullYear();
  const month = focal.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const leadingBlankDays = firstOfMonth.getDay();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(year, month, 1 - leadingBlankDays + i);
    cells.push({
      date: cellDate,
      day: cellDate.getDate(),
      inMonth: cellDate.getMonth() === month,
      isToday: isSameDay(cellDate, today),
      isFocal: isSameDay(cellDate, focal),
      key: dayKey(cellDate),
    });
  }
  return cells;
}

// ---- Singleton state ------------------------------------------------
//
// The whole point of this module: keep one copy of each Graffiti
// discovery for the lifetime of the page, no matter how many
// components ask for it.

let sharedInstance = null;

// We initialize inside a detached `effectScope` so the discoveries'
// internal watchers aren't tied to whichever component happened to
// call us first. If that component later unmounts (e.g. because we
// route between pages), the streams keep running.
let sharedScope = null;

export function useSharedChatData() {
  if (sharedInstance) return sharedInstance;

  // First call MUST happen during a component setup (the Graffiti
  // composables `useGraffiti` / `useGraffitiSession` use Vue
  // `inject`, which needs the active component instance). In this
  // app the root `App` (chat.js) always mounts first and never
  // unmounts, so calling `useSharedChatData()` at the top of its
  // setup is the right entry point.
  sharedScope = effectScope(true);

  sharedScope.run(() => {
    const graffiti = useGraffiti();
    const session = useGraffitiSession();

    // ---- Discoveries ------------------------------------------------
    //
    // Every page in the app that reads from Graffiti reads from these
    // streams. Five queries total — same as before the refactor, but
    // now there's one set of them instead of one per route.

    // Chats live in their owner's inbox channel as well as their own
    // random channel. The inbox query is what lets a user find chats
    // they belong to without having to know the random channel.
    const { objects: chats, isFirstPoll: areChatsLoading } =
      useGraffitiDiscover(
        () => (session.value ? [session.value.actor] : []),
        CHAT_SCHEMA,
        () => session.value,
        true,
      );

    // Per-user Leave markers, used to hide chats the user has left
    // even when they're not the chat's creator (and so can't modify
    // the chat object's allowed list directly).
    const { objects: leaveObjects } = useGraffitiDiscover(
      () => (session.value ? [session.value.actor] : []),
      LEAVE_SCHEMA,
      () => session.value,
      true,
    );

    // Per-user Later / Schedule markers. Both flavors share a schema
    // so a single discovery covers them and the dismissal/cleanup
    // paths don't need a second query.
    const { objects: laterObjects } = useGraffitiDiscover(
      () => (session.value ? [session.value.actor] : []),
      LATER_SCHEMA,
      () => session.value,
    );

    // Per-user Read markers. We always take the max `lastReadAt` for
    // a chat so old markers can be left in place harmlessly.
    const { objects: readObjects } = useGraffitiDiscover(
      () => (session.value ? [session.value.actor] : []),
      READ_SCHEMA,
      () => session.value,
    );

    // Per-user ScheduleSend markers. Each represents a message
    // queued for future delivery. When `scheduledFor` passes, the
    // auto-send timer in chat.js executes the send and deletes
    // the marker.
    const { objects: scheduledSendObjects } = useGraffitiDiscover(
      () => (session.value ? [session.value.actor] : []),
      SCHEDULED_SEND_SCHEMA,
      () => session.value,
    );

    // ---- Derived state ---------------------------------------------

    const leftChannels = computed(
      () => new Set(leaveObjects.value.map((o) => o.value.target)),
    );

    // Derive from targetChannel (the chat channel) so the sidebar's
    // green dot still lights up for any chat containing a later-
    // marked message.
    const laterChannels = computed(
      () => new Set(laterObjects.value.map((o) => o.value.targetChannel)),
    );

    // Set of message URLs currently marked for later — drives the
    // green dot rendered next to individual messages in the chat.
    const laterMessageUrls = computed(
      () => new Set(laterObjects.value.map((o) => o.value.target)),
    );

    // Map<messageUrl, LaterObject[]> for quick lookup when toggling
    // or clearing a specific message's later state.
    const laterObjectsByMessageUrl = computed(() => {
      const map = new Map();
      for (const o of laterObjects.value) {
        const url = o.value.target;
        const list = map.get(url);
        if (list) list.push(o);
        else map.set(url, [o]);
      }
      return map;
    });

    // Map<channel, number> — count of later-marked messages per chat.
    // Drives the "# Messages to Reply to Later" header chip.
    const laterCountByChannel = computed(() => {
      const map = new Map();
      for (const o of laterObjects.value) {
        const ch = o.value.targetChannel;
        map.set(ch, (map.get(ch) ?? 0) + 1);
      }
      return map;
    });

    // Highest `published` per chat channel from ANY sender (including
    // the logged-in user). Used to define "recency" for sorting the
    // sidebar. Falls back to the chat's own `published` timestamp
    // (creation time) so brand-new chats without messages still sort
    // sensibly.
    const latestActivityByChannel = computed(() => {
      const map = new Map();
      for (const m of allMessageObjects.value) {
        const ts = m.value.published;
        for (const ch of m.channels ?? []) {
          const existing = map.get(ch) ?? 0;
          if (ts > existing) map.set(ch, ts);
        }
      }
      return map;
    });

    // Set of channels that have at least one pending ScheduleSend.
    const scheduledSendChannels = computed(
      () => new Set(scheduledSendObjects.value.map((o) => o.value.targetChannel)),
    );

    // Map<channel, number> — count of pending ScheduleSend markers per
    // chat. Drives the "X Message(s) Pending Schedule Send" pill in the
    // chat header. Each marker counts once because a queued send is a
    // single (one message, one delivery time) pair.
    const scheduledSendCountByChannel = computed(() => {
      const map = new Map();
      for (const o of scheduledSendObjects.value) {
        const ch = o.value.targetChannel;
        map.set(ch, (map.get(ch) ?? 0) + 1);
      }
      return map;
    });

    // True when a chat has a scheduled-send marker targeting it.
    function hasScheduledSend(chat) {
      return scheduledSendChannels.value.has(chat.value.channel);
    }

    // Helper: recency timestamp for a chat (latest message from anyone,
    // falling back to the chat creation timestamp).
    function chatActivity(chat) {
      return latestActivityByChannel.value.get(chat.value.channel)
        ?? chat.value.published;
    }

    // Most-recent chats first, excluding ones the user has left.
    // Sorted by creation time — deliberately NOT by message activity,
    // because `allChatChannels` (which drives the message discovery)
    // depends on this list. If we sorted by activity here, we'd
    // create a circular dependency:
    //   sortedChats → latestActivityByChannel → allMessageObjects
    //   → allChatChannels → sortedChats
    // which can prevent `isFirstPoll` from ever flipping to false.
    const sortedChats = computed(() =>
      chats.value
        .filter((c) => !leftChannels.value.has(c.value.channel))
        .toSorted((a, b) => b.value.published - a.value.published),
    );

    // ---- Two-section sidebar sorting --------------------------------
    //
    // These computed properties use `chatActivity` (which reads from
    // allMessageObjects via latestActivityByChannel), but they are
    // NOT in the dependency chain that feeds allChatChannels, so
    // there is no circular dependency.
    //
    // Most Recent: top 3 chats by activity recency.
    const recentChats = computed(() =>
      sortedChats.value
        .toSorted((a, b) => chatActivity(b) - chatActivity(a))
        .slice(0, 3),
    );

    // Other Chats: every visible chat EXCEPT the top 3, ordered by
    // category then recency within each category:
    //   1. Chats with new (unread) messages
    //   2. Chats with Later markers or ScheduledSend markers
    //   3. Everything else
    const otherChats = computed(() => {
      const recentUrls = new Set(recentChats.value.map((c) => c.url));
      const rest = sortedChats.value.filter((c) => !recentUrls.has(c.url));

      const withNew = [];
      const withLater = [];
      const other = [];

      for (const chat of rest) {
        const unread = hasUnread(chat);
        const later = isLater(chat) || hasScheduledSend(chat);
        if (unread) {
          withNew.push(chat);
        } else if (later) {
          withLater.push(chat);
        } else {
          other.push(chat);
        }
      }

      // Sort each sub-array by activity recency.
      const byActivity = (a, b) => chatActivity(b) - chatActivity(a);
      withNew.sort(byActivity);
      withLater.sort(byActivity);
      other.sort(byActivity);

      return [...withNew, ...withLater, ...other];
    });

    // Channels the user is currently a member of (and hasn't left).
    // Used to gate message discovery: if the user opens
    // /#/chat/<channel> for a chat they're not in, that channel never
    // ends up here, so we never query for it — which keeps us from
    // broadcasting "this user is curious about that channel" just
    // because someone shared a URL with them.
    //
    // IMPORTANT: We stabilize the array reference so it only changes
    // when the *actual set of channel strings* changes. Without this,
    // every Graffiti autopoll gives `chats` new object references →
    // `sortedChats` recomputes → a naïve `.map()` returns a new array
    // reference → `useGraffitiDiscover` for messages & reactions
    // interprets that as a parameter change → re-initializes its
    // internal subscription → briefly clears its `objects` ref →
    // messages and reactions visibly flicker in/out.

    let _prevChannelKey = "";
    let _prevChannels = [];
    const allChatChannels = computed(() => {
      const next = sortedChats.value.map((c) => c.value.channel);
      const key = next.join("\0");
      if (key === _prevChannelKey) return _prevChannels;
      _prevChannelKey = key;
      _prevChannels = next;
      return next;
    });

    // Messages across every chat the user belongs to in a single
    // autopolling query. We need the cross-chat view (rather than an
    // active-chat-only one) so the sidebar can light up an unread dot
    // on chats the user *isn't* currently viewing as soon as a new
    // message arrives.
    const { objects: allMessageObjects, isFirstPoll: areAllMessagesLoading } =
      useGraffitiDiscover(
        () => allChatChannels.value,
        MESSAGE_SCHEMA,
        () => session.value,
        true,
      );

    // Reactions across every chat the user belongs to. Same channel
    // set as messages because reactions live in the chat's own random
    // channel — that way every existing chat member already discovers
    // them without any extra plumbing. Autopolled so a new emoji
    // someone else adds shows up on your screen without you having
    // to do anything.
    const { objects: reactionObjects } = useGraffitiDiscover(
      () => allChatChannels.value,
      REACTION_SCHEMA,
      () => session.value,
      true,
    );

    // Map<messageUrl, Reaction[]>. Computed once here so every
    // <reaction> instance in the message list does an O(1) lookup
    // rather than a full scan of `reactionObjects` per render.
    const reactionsByMessageUrl = computed(() => {
      const map = new Map();
      for (const r of reactionObjects.value) {
        const target = r.value.target;
        if (typeof target !== "string") continue;
        const list = map.get(target);
        if (list) list.push(r);
        else map.set(target, [r]);
      }
      return map;
    });

    // Highest `published` per chat channel — but only for messages
    // the logged-in user did NOT send. A chat shouldn't light up its
    // unread dot just because *you* posted in it. (Without this
    // filter the dot would briefly appear in the sidebar every time
    // you sent a message.)
    const latestMessageByChannel = computed(() => {
      const map = new Map();
      const me = session.value?.actor;
      for (const m of allMessageObjects.value) {
        if (m.actor === me) continue;
        const ts = m.value.published;
        for (const ch of m.channels ?? []) {
          const existing = map.get(ch) ?? 0;
          if (ts > existing) map.set(ch, ts);
        }
      }
      return map;
    });

    const lastReadByChannel = computed(() => {
      const map = new Map();
      for (const r of readObjects.value) {
        const ts = r.value.lastReadAt;
        const target = r.value.target;
        const existing = map.get(target) ?? 0;
        if (ts > existing) map.set(target, ts);
      }
      return map;
    });

    function isLater(chat) {
      return laterChannels.value.has(chat.value.channel);
    }

    // True when a chat has at least one message published after the
    // user's most recent read marker for that chat. We hold off until
    // the message poll has completed so the sidebar/sorted board
    // don't flash unread state on every page load before data
    // arrives.
    function hasUnread(chat) {
      if (areAllMessagesLoading.value) return false;
      const channel = chat.value.channel;
      const latestMsg = latestMessageByChannel.value.get(channel) ?? 0;
      if (!latestMsg) return false;
      const lastRead = lastReadByChannel.value.get(channel) ?? 0;
      return latestMsg > lastRead;
    }

    // Latest scheduledFor per channel (max wins). Both the chat
    // header chip and the calendar use this — chat asks for one
    // channel, the calendar walks every key.
    const scheduledForByChannel = computed(() => {
      const map = new Map();
      for (const o of laterObjects.value) {
        const when = o.value.scheduledFor;
        if (typeof when !== "number") continue;
        const channel = o.value.targetChannel;
        const existing = map.get(channel);
        if (existing === undefined || when > existing) {
          map.set(channel, when);
        }
      }
      return map;
    });

    // Map<dayKey, Array<{ laterUrl, channel, title, messagePreview, scheduledFor, type }>>.
    // Markers whose target chat the user has left (or has never had
    // access to) are skipped — the calendar shouldn't expose chats
    // the rest of the UI hides.
    //
    // Both reply-reminder and scheduled-send events are folded into
    // the same map so the calendar renders them side by side. The
    // `type` field ("reply" or "send") lets the UI distinguish them
    // with different colors.
    const scheduledByDay = computed(() => {
      const map = new Map();
      const visibleChats = new Map(
        chats.value
          .filter((c) => !leftChannels.value.has(c.value.channel))
          .map((c) => [c.value.channel, c]),
      );

      // Reply-reminder markers (Later objects with scheduledFor).
      for (const later of laterObjects.value) {
        const when = later.value.scheduledFor;
        if (typeof when !== "number") continue;
        const chat = visibleChats.get(later.value.targetChannel);
        if (!chat) continue;
        const key = dayKey(new Date(when));
        const entry = {
          laterUrl: later.url,
          channel: later.value.targetChannel,
          messageUrl: later.value.target,
          title: chat.value.title,
          messagePreview: later.value.messagePreview,
          scheduledFor: when,
          type: "reply",
        };
        const list = map.get(key);
        if (list) list.push(entry);
        else map.set(key, [entry]);
      }

      // Scheduled-send markers.
      for (const send of scheduledSendObjects.value) {
        const when = send.value.scheduledFor;
        if (typeof when !== "number") continue;
        const chat = visibleChats.get(send.value.targetChannel);
        if (!chat) continue;
        const key = dayKey(new Date(when));
        const entry = {
          laterUrl: send.url,
          channel: send.value.targetChannel,
          title: chat.value.title,
          messagePreview: send.value.content,
          scheduledFor: when,
          type: "send",
        };
        const list = map.get(key);
        if (list) list.push(entry);
        else map.set(key, [entry]);
      }

      for (const arr of map.values()) {
        arr.sort((a, b) => a.scheduledFor - b.scheduledFor);
      }
      return map;
    });

    // Bucket every visible chat into one of four kanban columns.
    //
    // The columns are not mutually exclusive: a chat that's marked
    // for later (or scheduled) AND has new messages shows up in BOTH
    // its later/scheduled column and the new-messages column, so the
    // user sees the same "both states are true" picture they get
    // from the sidebar's two dots. The Read column is still
    // exclusive — it's the catch-all for chats with no other state.
    //
    // We pre-bucket `laterObjects` by channel so we don't rescan the
    // full marker list once per chat.
    // Now message-level: each later marker becomes its own entry in
    // the scheduled / plainLater columns (with a message preview),
    // rather than one entry per chat. Chats with unread messages
    // still bucket by chat.
    const sortedColumns = computed(() => {
      const newMessages = [];
      const scheduled = [];
      const plainLater = [];

      const latersByChannel = new Map();
      for (const o of laterObjects.value) {
        const ch = o.value.targetChannel;
        const list = latersByChannel.get(ch);
        if (list) list.push(o);
        else latersByChannel.set(ch, [o]);
      }

      // Track which chats have any later/scheduled markers so we can
      // still put the chat in the Read column if it has none.
      const chatsWithLater = new Set();

      // Build per-message entries for scheduled and plain-later columns.
      for (const o of laterObjects.value) {
        const ch = o.value.targetChannel;
        const chat = sortedChats.value.find((c) => c.value.channel === ch);
        if (!chat) continue;
        chatsWithLater.add(ch);

        if (typeof o.value.scheduledFor === "number") {
          scheduled.push({
            chat,
            messagePreview: o.value.messagePreview,
            messageUrl: o.value.target,
            scheduledFor: o.value.scheduledFor,
          });
        } else {
          plainLater.push({
            chat,
            messagePreview: o.value.messagePreview,
            messageUrl: o.value.target,
          });
        }
      }

      for (const chat of sortedChats.value) {
        const channel = chat.value.channel;
        const isUnread = hasUnread(chat);
        const hasAnyLater = chatsWithLater.has(channel);

        if (isUnread) {
          newMessages.push({ chat });
        }
      }

      // Surface the soonest deadline first; the other columns inherit
      // sortedChats' "most recent activity first" ordering.
      scheduled.sort((a, b) => a.scheduledFor - b.scheduledFor);

      return { newMessages, scheduled, plainLater };
    });

    // ---- Mutations -------------------------------------------------
    //
    // These wrap `graffiti.post` / `graffiti.delete` calls that any
    // page might want to trigger. Components keep their own busy
    // flags and form state; they just await these and let the
    // discoveries above pick the change up reactively.

    // Mark a specific message for later. `messageUrl` is the Graffiti
    // URL of the message object, `channel` is the chat it belongs to,
    // `messagePreview` is a short snippet of its text content.
    async function markMessageAsLater(messageUrl, channel, messagePreview) {
      if (!session.value || !messageUrl || !channel) return;
      // No-op if already marked — rapid double-clicks shouldn't pile
      // up redundant objects.
      if (laterMessageUrls.value.has(messageUrl)) return;
      try {
        const now = Date.now();
        await graffiti.post(
          {
            value: {
              activity: "Later",
              target: messageUrl,
              targetChannel: channel,
              messagePreview: messagePreview ?? "",
              published: now,
            },
            channels: [session.value.actor],
            allowed: [],
          },
          session.value,
        );
      } catch {
        // Best effort — if the post fails the user can simply press
        // Later again. We don't surface an error toast for this.
      }
    }

    // Clear all Later markers for a specific message URL.
    async function clearMessageLater(messageUrl) {
      if (!session.value || !messageUrl) return;
      const matches = laterObjects.value.filter(
        (o) => o.value.target === messageUrl,
      );
      await Promise.all(
        matches.map(async (o) => {
          try {
            await graffiti.delete(o.url, session.value);
          } catch {
            // Ignore — the next discover poll will reflect reality.
          }
        }),
      );
    }

    // Clear ALL Later markers for a given chat channel. Used when the
    // user sends a message (replying satisfies the "remind me later"
    // intent for every message in that chat).
    async function clearLater(channel) {
      if (!session.value || !channel) return;
      const matches = laterObjects.value.filter(
        (o) => o.value.targetChannel === channel,
      );
      await Promise.all(
        matches.map(async (o) => {
          try {
            await graffiti.delete(o.url, session.value);
          } catch {
            // Ignore — the next discover poll will reflect reality.
          }
        }),
      );
    }

    async function markChatAsRead(channel) {
      if (!session.value || !channel) return;
      const now = Date.now();
      try {
        await graffiti.post(
          {
            value: {
              activity: "Read",
              target: channel,
              lastReadAt: now,
              published: now,
            },
            channels: [session.value.actor],
            allowed: [],
          },
          session.value,
        );
      } catch {
        // Best effort — a failed read marker just means the dot may
        // linger until the next successful mark.
      }
    }

    // Schedule a reply for a specific message at the user-picked
    // timestamp. Snapshots the prior markers for THIS MESSAGE
    // BEFORE the post so the cleanup loop doesn't accidentally
    // include the brand-new one (which appears in `laterObjects`
    // reactively as soon as discover sees it).
    async function scheduleLater(messageUrl, channel, messagePreview, when) {
      if (!session.value || !messageUrl || !channel) return;
      if (typeof when !== "number") return;

      const priorMarkers = laterObjects.value.filter(
        (o) => o.value.target === messageUrl,
      );

      const now = Date.now();
      await graffiti.post(
        {
          value: {
            activity: "Later",
            target: messageUrl,
            targetChannel: channel,
            messagePreview: messagePreview ?? "",
            published: now,
            scheduledFor: when,
          },
          channels: [session.value.actor],
          allowed: [],
        },
        session.value,
      );

      await Promise.all(
        priorMarkers.map(async (o) => {
          try {
            await graffiti.delete(o.url, session.value);
          } catch {
            // Best effort. Stale markers are harmless; the calendar
            // dedupes by message + scheduledFor anyway.
          }
        }),
      );
    }

    // Returns the new chat's random channel UUID so the caller can
    // route to it (e.g. /#/chat/<channel>).
    async function createChat(title) {
      if (!session.value) return null;
      const cleaned = title?.trim();
      if (!cleaned) return null;
      const chatChannel = crypto.randomUUID();
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "Chat",
            channel: chatChannel,
            title: cleaned,
            published: Date.now(),
            // Member list duplicated inside `value` so non-creator
            // members (whose view of `allowed` is masked) can still
            // see the roster.
            members: [session.value.actor],
          },
          // Live in the chat's own random channel AND the creator's
          // inbox so the creator can find it via inbox discovery.
          channels: [chatChannel, session.value.actor],
          // Only the creator can read it at creation time. Adding
          // members appends them to this list (see addMemberToChat).
          allowed: [session.value.actor],
        },
        session.value,
      );
      return chatChannel;
    }

    // Send a message in `chat`. Posts in the chat's specific random
    // channel so other members will pick it up via their own message
    // discovery query. The allowed list mirrors the chat's member
    // list so exactly the people who can see the chat can also see
    // its messages.
    //
    // `inReplyTo` is an optional Graffiti URL of the message being
    // replied to. When present, the posted object includes an
    // `inReplyTo` field that the UI uses to render reply indicators.
    //
    // Replying satisfies the "remind me later" intent so we also
    // drop any outstanding Later markers for this channel.
    async function sendMessageToChat(chat, text, inReplyTo) {
      if (!session.value || !chat) return;
      const cleaned = text?.trim();
      if (!cleaned) return;
      const channel = chat.value.channel;
      const messageValue = {
        activity: "Send",
        type: "Message",
        content: cleaned,
        published: Date.now(),
      };
      if (inReplyTo) {
        messageValue.inReplyTo = inReplyTo;
      }
      await graffiti.post(
        {
          value: messageValue,
          channels: [channel],
          // Read from value.members (visible to every member, unlike
          // the masked `allowed` list) so every member can see the
          // message.
          allowed: [...(chat.value.members ?? [])],
        },
        session.value,
      );
      // If this was a direct reply to a specific message, clear any
      // Later markers on that message (replying satisfies the intent).
      if (inReplyTo && laterMessageUrls.value.has(inReplyTo)) {
        await clearMessageLater(inReplyTo);
      }
    }

    // Add a reaction to `message` inside `chat`. Posted in the chat's
    // own random channel and gated by the chat's member list (mirroring
    // sendMessageToChat) so exactly the people who can see the message
    // can also see the reaction.
    //
    // No-op when the user has already reacted to this message with
    // this same emoji — the spec is "stacking only happens when
    // multiple people react", not "one user can stack with themselves".
    // The chip's own click handler is what flips an existing reaction
    // off; this path only ever creates new ones.
    async function addReaction(message, chat, emoji) {
      if (!session.value) return;
      if (!message?.url || !chat?.value?.channel || !emoji) return;
      const me = session.value.actor;
      const existing = (reactionsByMessageUrl.value.get(message.url) ?? []).find(
        (r) => r.actor === me && r.value.emoji === emoji,
      );
      if (existing) return;
      try {
        await graffiti.post(
          {
            value: {
              activity: "React",
              type: "Reaction",
              target: message.url,
              emoji,
              published: Date.now(),
            },
            channels: [chat.value.channel],
            allowed: [...(chat.value.members ?? [])],
          },
          session.value,
        );
      } catch {
        // Best effort. The user can re-click; we don't toast for this.
      }
    }

    // Remove a previously posted reaction (only the poster can do this,
    // which is enforced by Graffiti). Used when the user clicks their
    // own reaction chip to take it back.
    async function removeReaction(reactionUrl) {
      if (!session.value || !reactionUrl) return;
      try {
        await graffiti.delete(reactionUrl, session.value);
      } catch {
        // Best effort. The next discover poll will reflect reality.
      }
    }

    // Share a chat with another user.
    //
    // The Graffiti API only exposes post / get / delete (no patch),
    // so "updating" the allowed list of a chat means deleting the
    // existing chat object and re-posting an equivalent one with the
    // new actor appended to both `allowed` (so they can see it) and
    // `channels` (so it shows up in their inbox during discovery).
    //
    // Throws an Error with a user-facing message on the validation
    // failures the calling form needs to display.
    async function addMemberToChat(chat, handle) {
      if (!session.value) throw new Error("Not signed in.");
      if (!chat) throw new Error("No chat selected.");
      const trimmed = handle?.trim();
      if (!trimmed) return;

      if (chat.actor !== session.value.actor) {
        throw new Error("Only the chat creator can add members.");
      }

      // We display handles without the ".graffiti.actor" suffix, so
      // accept input in that same shorter form and re-attach the
      // suffix here when resolving back to an actor URI.
      const fullHandle = trimmed.endsWith(HANDLE_SUFFIX)
        ? trimmed
        : trimmed + HANDLE_SUFFIX;
      let newActor;
      try {
        newActor = await graffiti.handleToActor(fullHandle);
      } catch {
        throw new Error(`Could not find a user named "${trimmed}".`);
      }

      // Use value.members as the source of truth for the roster — it
      // isn't masked the way `allowed` is for non-creators.
      const existingMembers = chat.value.members ?? [];
      if (existingMembers.includes(newActor)) {
        throw new Error("That user is already in this chat.");
      }

      const newMembers = [...existingMembers, newActor];
      // Channels: keep the chat's random channel and place the chat
      // in every member's inbox so each one can discover it.
      const newChannels = [chat.value.channel, ...newMembers];

      // Post the new (shared) chat object first so there's no flash
      // of "no chats" for the creator while discovery re-syncs.
      await graffiti.post(
        {
          value: { ...chat.value, members: newMembers },
          channels: newChannels,
          allowed: newMembers,
        },
        session.value,
      );
      // Then delete the old object so we don't end up with
      // duplicates.
      await graffiti.delete(chat.url, session.value);
    }

    // Leave `chat`. Any user can leave, including the creator.
    //
    // Because Graffiti only lets the creator of an object modify it,
    // the mechanics differ depending on whether the leaver is the
    // creator:
    //   * Creator, alone:   delete the chat object outright.
    //   * Creator, others:  delete-and-repost the chat without
    //                       themselves in members/allowed/channels.
    //                       They lose the ability to administer the
    //                       chat going forward (no one else can
    //                       either), but the remaining members can
    //                       keep using it.
    //   * Non-creator:      they can't touch the chat object, so we
    //                       just record a private Leave marker in
    //                       their own inbox so the app hides the
    //                       chat from their UI.
    // In every case we also write a private Leave marker so the chat
    // stays hidden from the leaver even if someone re-adds them
    // later.
    async function leaveChat(chat) {
      if (!session.value || !chat) return;
      const me = session.value.actor;
      const channel = chat.value.channel;

      if (chat.actor === me) {
        const remainingMembers = (chat.value.members ?? []).filter(
          (m) => m !== me,
        );

        if (remainingMembers.length === 0) {
          await graffiti.delete(chat.url, session.value);
        } else {
          // Re-post the chat for the remaining members first so they
          // don't briefly lose access while we tear down the old one.
          await graffiti.post(
            {
              value: { ...chat.value, members: remainingMembers },
              channels: [channel, ...remainingMembers],
              allowed: remainingMembers,
            },
            session.value,
          );
          await graffiti.delete(chat.url, session.value);
        }
      }

      await graffiti.post(
        {
          value: {
            activity: "Leave",
            target: channel,
            published: Date.now(),
          },
          channels: [me],
          allowed: [],
        },
        session.value,
      );
    }

    // ---- Scheduled Send mutations -----------------------------------

    // Create a scheduled-send marker. The message `content` will be
    // delivered to `channel` when the `when` timestamp passes.
    async function createScheduledSend(channel, content, when) {
      if (!session.value || !channel || !content || typeof when !== "number") return;
      try {
        await graffiti.post(
          {
            value: {
              activity: "ScheduleSend",
              type: "ScheduledMessage",
              content,
              targetChannel: channel,
              scheduledFor: when,
              published: Date.now(),
            },
            channels: [session.value.actor],
            allowed: [],
          },
          session.value,
        );
      } catch {
        // Best effort — user can retry.
      }
    }

    // Delete a scheduled-send marker (e.g. after auto-send or manual cancel).
    async function deleteScheduledSend(url) {
      if (!session.value || !url) return;
      try {
        await graffiti.delete(url, session.value);
      } catch {
        // Best effort.
      }
    }

    // Execute a scheduled send: look up the target chat, send the
    // message via the existing `sendMessageToChat` path, then delete
    // the marker so it disappears from the calendar.
    async function executeScheduledSend(sendObj) {
      if (!session.value || !sendObj) return;
      const channel = sendObj.value.targetChannel;
      const chat = chats.value.find((c) => c.value.channel === channel);
      if (!chat) return; // Can't send if the user left / chat deleted.
      const content = sendObj.value.content;
      if (!content) return;
      await sendMessageToChat(chat, content, null);
      await deleteScheduledSend(sendObj.url);
    }

    // Generic delete for any object the user owns (used by the chat
    // view's soft-delete + undo flow). Exposed here so the chat
    // component doesn't need to import `useGraffiti` directly.
    async function deleteObject(url) {
      if (!session.value || !url) return;
      await graffiti.delete(url, session.value);
    }

    sharedInstance = {
      // session is re-exposed so callers don't need a second
      // useGraffitiSession() call (and its corresponding inject).
      session,

      // Streams
      chats,
      areChatsLoading,
      leaveObjects,
      laterObjects,
      readObjects,
      allMessageObjects,
      areAllMessagesLoading,
      reactionObjects,
      scheduledSendObjects,

      // Derived state
      leftChannels,
      laterChannels,
      laterMessageUrls,
      laterObjectsByMessageUrl,
      laterCountByChannel,
      sortedChats,
      recentChats,
      otherChats,
      allChatChannels,
      latestActivityByChannel,
      latestMessageByChannel,
      lastReadByChannel,
      scheduledForByChannel,
      scheduledSendChannels,
      scheduledSendCountByChannel,
      scheduledByDay,
      sortedColumns,
      reactionsByMessageUrl,

      // Predicates
      hasUnread,
      isLater,
      hasScheduledSend,

      // Mutations
      markMessageAsLater,
      clearMessageLater,
      clearLater,
      markChatAsRead,
      scheduleLater,
      createChat,
      sendMessageToChat,
      addMemberToChat,
      leaveChat,
      deleteObject,
      addReaction,
      removeReaction,
      createScheduledSend,
      deleteScheduledSend,
      executeScheduledSend,
    };
  });

  return sharedInstance;
}
