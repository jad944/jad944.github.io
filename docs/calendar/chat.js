import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import {
  useSharedChatData,
  buildMonthGrid,
  dayKey,
  formatTime,
  WEEKDAY_LABELS,
} from "../sharedChatData.js";

// Lazy-load this component's stylesheet exactly once. We do it from
// JS instead of the parent index.html so the calendar route owns its
// own CSS — going to /#/calendar pulls it in, anything else doesn't.
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

  // All Graffiti queries (chats, leave markers, later/scheduled
  // markers) and the cross-page `scheduledByDay` map come from the
  // shared composable. Because the root App's setup already
  // initialized it, this call is just returning the cached singleton
  // — no extra discovery polls fire as a result of mounting the
  // calendar route.
  const { scheduledByDay } = useSharedChatData();

  // The calendar's focal date — for month view it's "any day in the
  // month being shown"; for day view it's "the day being shown". A
  // single ref keeps prev/next coherent when the user toggles views.
  // Page-local because it has no meaning anywhere outside this view.
  const calendarView = ref("month");
  const calendarDate = ref(new Date());

  function setCalendarView(view) {
    if (view !== "day" && view !== "month") return;
    calendarView.value = view;
  }

  function goPrevPeriod() {
    const d = new Date(calendarDate.value);
    if (calendarView.value === "month") {
      d.setMonth(d.getMonth() - 1);
    } else {
      d.setDate(d.getDate() - 1);
    }
    calendarDate.value = d;
  }

  function goNextPeriod() {
    const d = new Date(calendarDate.value);
    if (calendarView.value === "month") {
      d.setMonth(d.getMonth() + 1);
    } else {
      d.setDate(d.getDate() + 1);
    }
    calendarDate.value = d;
  }

  function goToToday() {
    calendarDate.value = new Date();
  }

  const monthTitle = computed(() =>
    calendarDate.value.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  );

  const dayTitle = computed(() =>
    calendarDate.value.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
  );

  // Bare grid (no events stitched on yet). Events are layered in
  // below once `scheduledByDay` is available.
  const monthGridBase = computed(() => buildMonthGrid(calendarDate.value));

  // 24 hourly slots for day view, labeled in 12-hour format. We don't
  // hard-bound the workday — the whole point of "respond later" is
  // that some replies happen outside 9-to-5.
  const dayHours = computed(() => {
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const label =
        h === 0
          ? "12 AM"
          : h < 12
            ? `${h} AM`
            : h === 12
              ? "12 PM"
              : `${h - 12} PM`;
      hours.push({ hour: h, label });
    }
    return hours;
  });

  function selectDay(cell) {
    calendarDate.value = new Date(cell.date);
    calendarView.value = "day";
  }

  function navigateBackFromCalendar() {
    router.push({ name: "home" });
  }

  function openChatFromCalendar(channel) {
    router.push({ name: "chat", params: { channel } });
  }

  // Stitch each cell with the scheduled events that fall on its day.
  const monthGrid = computed(() =>
    monthGridBase.value.map((cell) => ({
      ...cell,
      events: scheduledByDay.value.get(cell.key) ?? [],
    })),
  );

  // Events for the day currently focused in the day view, grouped by
  // hour-of-day so each hour-row in the template can render its own.
  const dayEventsByHour = computed(() => {
    const events = scheduledByDay.value.get(dayKey(calendarDate.value)) ?? [];
    const map = new Map();
    for (const e of events) {
      const hour = new Date(e.scheduledFor).getHours();
      const list = map.get(hour);
      if (list) list.push(e);
      else map.set(hour, [e]);
    }
    return map;
  });

  return {
    calendarView,
    setCalendarView,
    monthTitle,
    dayTitle,
    weekdayLabels: WEEKDAY_LABELS,
    monthGrid,
    dayHours,
    dayEventsByHour,
    goPrevPeriod,
    goNextPeriod,
    goToToday,
    selectDay,
    navigateBackFromCalendar,
    openChatFromCalendar,
    formatTime,
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
