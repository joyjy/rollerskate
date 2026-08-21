import {
  createRouter,
  createWebHistory,
  type RouterHistory,
  type RouteRecordRaw
} from "vue-router";

import ConsoleEntry from "@/views/ConsoleEntry.vue";
import ConsoleLayout from "@/views/ConsoleLayout.vue";
import AgentsView from "@/views/AgentsView.vue";
import ChatsView from "@/views/ChatsView.vue";
import EventsView from "@/views/EventsView.vue";
import RuntimeView from "@/views/RuntimeView.vue";
import StewardView from "@/views/StewardView.vue";
import SchedulesView from "@/views/SchedulesView.vue";
import SubscriptionsView from "@/views/SubscriptionsView.vue";
import NetworkView from "@/views/NetworkView.vue";

export const consoleRoutes: RouteRecordRaw[] = [
    {
      path: "/console",
      name: "console-entry",
      component: ConsoleEntry
    },
    {
      path: "/console",
      component: ConsoleLayout,
      children: [
        { path: "runtime", name: "runtime", component: RuntimeView },
        { path: "events", name: "events", component: EventsView },
        { path: "agents", name: "agents", component: AgentsView },
        { path: "network", name: "network", component: NetworkView },
        { path: "chats", name: "chats", component: ChatsView },
        { path: "steward", name: "steward", component: StewardView },
        { path: "schedules", name: "schedules", component: SchedulesView },
        {
          path: "subscriptions",
          name: "subscriptions",
          component: SubscriptionsView
        }
      ]
    },
    {
      path: "/:pathMatch(.*)*",
      redirect: "/console"
    }
];

export function createConsoleRouter(history: RouterHistory) {
  return createRouter({
    history,
    routes: consoleRoutes
  });
}

export const router = createConsoleRouter(createWebHistory());
