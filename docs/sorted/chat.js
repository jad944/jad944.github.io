import { useRouter } from "vue-router";
import {
  useSharedChatData,
  formatScheduledLabel,
} from "../sharedChatData.js";

// Lazy-load this component's stylesheet exactly once. We do it from
// JS instead of the parent index.html so the sorted route owns its
// own CSS — going to /#/sorted pulls it in, anything else doesn't.
function ensureStylesheet() {
  const href = new URL("./style.css", import.meta.url).href;
  if (document.querySelector(`link[data-component-style="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.componentStyle = href;
  document.head.appendChild(link);
}

function setup() {
  const router = useRouter();

  // Every Graffiti query the kanban needs (chats, leave markers,
  // later/scheduled markers, read markers, all messages) plus the
  // per-column bucketing computed (`sortedColumns`) lives in the
  // shared composable. By the time the user navigates to /#/sorted
  // the root App's setup has already initialized those streams, so
  // this call just hands back the cached singleton — no duplicate
  // discovery polls.
  const { areChatsLoading, sortedColumns } = useSharedChatData();

  function navigateBackFromSorted() {
    router.push({ name: "home" });
  }

  function openChatFromSorted(channel) {
    router.push({ name: "chat", params: { channel } });
  }

  return {
    areChatsLoading,
    sortedColumns,
    formatScheduledLabel,
    navigateBackFromSorted,
    openChatFromSorted,
  };
}

export default async () => {
  ensureStylesheet();
  return {
    setup,
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
      r.text(),
    ),
  };
};
