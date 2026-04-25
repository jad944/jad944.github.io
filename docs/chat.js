import { createApp, ref, computed } from "vue";
import { GraffitiLocal } from "@graffiti-garden/implementation-local";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import {
  GraffitiPlugin,
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";

// JSON schema describing a chat-creation object.
// Re-used both for discovery and as documentation of the object shape.
//
// Note: we duplicate the member list inside `value.members` even though
// it mirrors the object's `allowed` list. This is because Graffiti masks
// the `allowed` list for non-creators (they only see themselves), so
// non-creator members would otherwise have no way to know who else is
// in the chat — which is needed to send messages everyone can see.
const CHAT_SCHEMA = {
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

// JSON schema describing a chat message object.
const MESSAGE_SCHEMA = {
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

// JSON schema describing a "Leave" marker. We use these so that a user
// who has left a chat can still hide it from their own view even when
// they're not the chat's creator and therefore can't modify the chat
// object's allowed list directly. Each Leave is posted privately in the
// leaving user's own inbox (allowed: []), with `target` set to the chat
// channel they left.
const LEAVE_SCHEMA = {
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

// Graffiti handles look like "username.graffiti.actor". The suffix is an
// implementation detail of the handle namespace and is noise to end users,
// so we strip it everywhere we display a handle and re-attach it (if the
// user didn't type it) when resolving a handle back into an actor URI.
const HANDLE_SUFFIX = ".graffiti.actor";

function displayHandle(handle) {
  if (handle === undefined) return "Loading...";
  if (handle === null) return "Unknown user";
  return handle.endsWith(HANDLE_SUFFIX)
    ? handle.slice(0, -HANDLE_SUFFIX.length)
    : handle;
}

function setup() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();

  const newChatTitle = ref("");
  const isCreatingChat = ref(false);

  // The random channel of the chat the user has currently opened.
  const activeChannel = ref(null);

  // Form state for adding a user to the active chat.
  const newMemberHandle = ref("");
  const isAddingMember = ref(false);
  const addMemberError = ref("");

  // Form state for sending a message in the active chat.
  const myMessage = ref("");
  const isSending = ref(false);
  // Track which message URLs are mid-deletion so we can disable the button.
  const isDeleting = ref(new Set());

  // Leave-chat confirmation modal state.
  const isLeaveDialogOpen = ref(false);
  const isLeavingChat = ref(false);

  // How long the user has to undo a delete before it is committed.
  const UNDO_DELETE_MS = 10000;
  // Messages whose deletion is pending (the 10-second timer hasn't fired).
  // Keyed by message URL so we can look up the entry from the toast and
  // either cancel the timer (undo) or let it run to completion. We hide
  // these messages from the UI so it feels deleted, but the actual
  // graffiti.delete call hasn't happened yet — that's what makes it
  // recoverable without re-posting (Graffiti forbids re-putting a deleted
  // object, see graffiti.md "delete" / "right to be forgotten").
  const pendingDeletes = ref(new Map());

  // Discover chats by looking in the logged-in user's "inbox" channel
  // (the channel named after their actor URI). The chat object is also
  // posted into its own random channel — see createChat — but discovery
  // by inbox is what lets a user find chats they belong to without having
  // to know the random channel up front.
  const { objects: chats, isFirstPoll: areChatsLoading } = useGraffitiDiscover(
    () => (session.value ? [session.value.actor] : []),
    CHAT_SCHEMA,
    () => session.value,
    true,
  );

  // Discover the Leave markers the logged-in user has previously posted
  // in their own inbox. We use these to hide chats they've left from
  // their chat list (a non-creator can't modify the chat's allowed
  // list, so we need a per-user marker).
  const { objects: leaveObjects } = useGraffitiDiscover(
    () => (session.value ? [session.value.actor] : []),
    LEAVE_SCHEMA,
    () => session.value,
    true,
  );

  // Set of chat channels the user has marked as left.
  const leftChannels = computed(
    () => new Set(leaveObjects.value.map((o) => o.value.target)),
  );

  // Most-recent chats first, excluding ones the user has left.
  const sortedChats = computed(() =>
    chats.value
      .filter((c) => !leftChannels.value.has(c.value.channel))
      .toSorted((a, b) => b.value.published - a.value.published),
  );

  // The chat currently open, derived from the active random channel.
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

  // Discover messages in the active chat. We look in that chat's specific
  // random channel (chat.value.channel). The session is passed so that
  // private (allowed-list) messages are returned to members.
  const {
    objects: messageObjects,
    isFirstPoll: areMessagesLoading,
  } = useGraffitiDiscover(
    () => (activeChannel.value ? [activeChannel.value] : []),
    MESSAGE_SCHEMA,
    () => session.value,
    true,
  );

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

  function selectChat(chat) {
    activeChannel.value = chat.value.channel;
    addMemberError.value = "";
    newMemberHandle.value = "";
  }

  async function createChat() {
    if (!session.value || !newChatTitle.value.trim()) return;
    isCreatingChat.value = true;
    try {
      const chatChannel = crypto.randomUUID();
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "Chat",
            channel: chatChannel,
            title: newChatTitle.value.trim(),
            published: Date.now(),
            // Member list duplicated inside `value` so non-creator members
            // (whose view of `allowed` is masked) can still see the roster.
            members: [session.value.actor],
          },
          // Live in the chat's own random channel AND the creator's inbox
          // so the creator can find it by querying their inbox.
          channels: [chatChannel, session.value.actor],
          // Only the creator can read it at creation time. Adding members
          // appends them to this list (see addUserToChat).
          allowed: [session.value.actor],
        },
        session.value,
      );
      newChatTitle.value = "";
      activeChannel.value = chatChannel;
    } finally {
      isCreatingChat.value = false;
    }
  }

  // Share the active chat with another user.
  //
  // The Graffiti API only exposes post / get / delete (no patch), so
  // "updating" the allowed list of a chat means deleting the existing
  // chat object and re-posting an equivalent one with the new actor
  // appended to both `allowed` (so they can see it) and `channels`
  // (so it shows up in their inbox during discovery).
  async function addUserToChat() {
    addMemberError.value = "";
    if (!session.value || !activeChat.value) return;
    const handle = newMemberHandle.value.trim();
    if (!handle) return;

    if (!isActiveChatOwner.value) {
      addMemberError.value = "Only the chat creator can add members.";
      return;
    }

    isAddingMember.value = true;
    try {
      // We display handles without the ".graffiti.actor" suffix, so accept
      // input in that same shorter form and re-attach the suffix here when
      // resolving back to an actor URI.
      const fullHandle = handle.endsWith(HANDLE_SUFFIX)
        ? handle
        : handle + HANDLE_SUFFIX;
      let newActor;
      try {
        newActor = await graffiti.handleToActor(fullHandle);
      } catch {
        addMemberError.value = `Could not find a user named "${handle}".`;
        return;
      }

      const chat = activeChat.value;
      // Use value.members as the source of truth for the roster — it
      // isn't masked the way `allowed` is for non-creators.
      const existingMembers = chat.value.members ?? [];
      if (existingMembers.includes(newActor)) {
        addMemberError.value = "That user is already in this chat.";
        return;
      }

      const newMembers = [...existingMembers, newActor];
      // Channels: keep the chat's random channel and place the chat in
      // every member's inbox so each one can discover it.
      const newChannels = [chat.value.channel, ...newMembers];

      // Post the new (shared) chat object first so there's no flash of
      // "no chats" for the creator while discovery re-syncs.
      await graffiti.post(
        {
          value: { ...chat.value, members: newMembers },
          channels: newChannels,
          allowed: newMembers,
        },
        session.value,
      );
      // Then delete the old object so we don't end up with duplicates.
      await graffiti.delete(chat.url, session.value);

      newMemberHandle.value = "";
    } finally {
      isAddingMember.value = false;
    }
  }

  // Open / close / confirm the "leave chat" guard dialog.
  function requestLeaveChat() {
    if (!activeChat.value) return;
    isLeaveDialogOpen.value = true;
  }

  function cancelLeaveChat() {
    if (isLeavingChat.value) return;
    isLeaveDialogOpen.value = false;
  }

  // Leave the active chat. Any user can leave, including the creator.
  //
  // Because Graffiti only lets the creator of an object modify it, the
  // mechanics differ depending on whether the leaver is the creator:
  //   * Creator, alone in the chat:  delete the chat object outright.
  //   * Creator, others remain:      delete-and-repost the chat without
  //                                  themselves in `members` / `allowed`
  //                                  / `channels`. They lose the ability
  //                                  to administer the chat going
  //                                  forward (no one else can either),
  //                                  but the remaining members can keep
  //                                  using it.
  //   * Non-creator:                 they can't touch the chat object,
  //                                  so we just record a private Leave
  //                                  marker in their own inbox so the
  //                                  app hides the chat from their UI.
  // In every case we also write a private Leave marker so the chat
  // stays hidden from the leaver even if someone re-adds them later.
  async function confirmLeaveChat() {
    if (!session.value || !activeChat.value) return;
    const chat = activeChat.value;
    const me = session.value.actor;
    const channel = chat.value.channel;

    isLeavingChat.value = true;
    try {
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

      // Always record a private Leave marker in our own inbox so the
      // chat stays hidden from us even if someone re-adds us later.
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

      activeChannel.value = null;
      isLeaveDialogOpen.value = false;
    } finally {
      isLeavingChat.value = false;
    }
  }

  // Send a message in the active chat.
  //
  // Where: posted in the chat's specific random channel so other members
  //        will pick it up via their open-chat discovery query.
  // Who:   the allowed list mirrors the chat's allowed list, so exactly
  //        the people who can see the chat can also see its messages.
  async function sendMessage() {
    if (!session.value || !activeChat.value) return;
    const text = myMessage.value.trim();
    if (!text) return;

    isSending.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Send",
            type: "Message",
            content: text,
            published: Date.now(),
          },
          channels: [activeChat.value.value.channel],
          // Mirror the chat's full member list (read from value.members,
          // which — unlike `allowed` — is visible to every member, not
          // just the creator) so every member can see the message.
          allowed: [...(activeChat.value.value.members ?? [])],
        },
        session.value,
      );
      myMessage.value = "";
    } finally {
      isSending.value = false;
    }
  }

  // "Soft" delete a message: hide it from the UI immediately and start a
  // 10-second timer. If the user clicks Undo before the timer fires, we
  // cancel the timer and the message reappears. Otherwise the actual
  // graffiti.delete runs and the message is gone for good.
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

  // Cancel a pending delete: clear the timer and drop the entry so the
  // message reappears in sortedMessages.
  function undoDelete(url) {
    const entry = pendingDeletes.value.get(url);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    const next = new Map(pendingDeletes.value);
    next.delete(url);
    pendingDeletes.value = next;
  }

  // Run the actual graffiti.delete after the undo window has expired.
  async function commitDelete(url) {
    const entry = pendingDeletes.value.get(url);
    if (!entry) return;

    const next = new Map(pendingDeletes.value);
    next.delete(url);
    pendingDeletes.value = next;

    isDeleting.value.add(url);
    try {
      await graffiti.delete(url, session.value);
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
  };
}

const App = { template: "#template", setup };

createApp(App)
  .use(GraffitiPlugin, {
    graffiti: new GraffitiDecentralized(),
  })
  .mount("#app");
