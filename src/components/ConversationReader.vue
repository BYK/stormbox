<script lang="ts">
export interface ConversationReaderMessage {
  key: string;
  sender: string;
  preview?: string | null;
  timestamp: number;
  unread?: boolean;
}
</script>

<script setup lang="ts">
import { computed, ref, shallowReactive, useId, watch } from 'vue';
import { ArrowLeft, ChevronRight } from '@lucide/vue';

import { fmtDate } from '../utils/message-row-presentation';
import AppIconButton from './AppIconButton.vue';

const props = withDefaults(defineProps<{
  subject: string | null | undefined;
  messages: readonly ConversationReaderMessage[];
  activeKey: string;
  backLabel?: string;
}>(), { backLabel: 'Back to messages' });

const emit = defineEmits<{
  select: [key: string];
  back: [];
}>();

const id = useId();
const titleId = `${id}-subject`;
const stack = ref<HTMLOListElement | null>(null);
const panels = shallowReactive(new Map<string, HTMLElement>());
const activePanel = computed(() => panels.get(props.activeKey));
const summaryId = (key: string) => `${id}-summary-${encodeURIComponent(key)}`;
const panelId = (key: string) => `${id}-panel-${encodeURIComponent(key)}`;
const messages = computed(() => [...props.messages].sort((a, b) => a.timestamp - b.timestamp).map((message) => {
  const date = new Date(message.timestamp);
  return {
    ...message,
    date: fmtDate(message.timestamp),
    dateTime: Number.isFinite(date.getTime()) ? date.toISOString() : undefined,
  };
}));
function setPanelRef(key: string, element: unknown) {
  if (element instanceof HTMLElement) panels.set(key, element);
  else panels.delete(key);
}

watch(activePanel, (panel) => {
  const list = stack.value;
  const heading = panel?.previousElementSibling;
  if (!list || !heading) return;
  const top = heading.getBoundingClientRect().top - list.getBoundingClientRect().top;
  if (top < 0 || top > list.clientHeight / 3) list.scrollTop += top;
}, { flush: 'post' });
</script>

<template>
  <section class="conversation-reader" :aria-labelledby="titleId">
    <header class="conversation-reader__toolbar">
      <AppIconButton :title="backLabel" :aria-label="backLabel" @click="emit('back')">
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <h2 :id="titleId" class="conversation-reader__title" :title="subject || undefined">{{ subject || '(no subject)' }}</h2>
      <div v-if="$slots.actions" class="conversation-reader__actions"><slot name="actions" /></div>
    </header>

    <ol ref="stack" class="conversation-reader__stack" role="list" aria-label="Messages in conversation">
      <li v-for="message in messages" :key="message.key" class="conversation-reader__message"
        :class="{ 'conversation-reader__message--active': message.key === activeKey }">
        <h3 class="conversation-reader__summary-heading">
          <button :id="summaryId(message.key)" type="button" class="conversation-reader__summary"
            :aria-controls="panelId(message.key)" :aria-expanded="message.key === activeKey"
            :aria-disabled="message.key === activeKey || undefined"
            @click="message.key !== activeKey && emit('select', message.key)">
            <ChevronRight :size="16" aria-hidden="true" class="conversation-reader__chevron" />
            <span class="conversation-reader__summary-text">
              <span class="conversation-reader__sender" :class="{ 'conversation-reader__sender--unread': message.unread }">
                {{ message.sender || '(no sender)' }}<span v-if="message.unread" class="conversation-reader__unread-label">, unread</span>
              </span>
              <span v-if="message.preview && message.key !== activeKey" class="conversation-reader__preview">{{ message.preview }}</span>
            </span>
            <time v-if="message.date" :datetime="message.dateTime" class="conversation-reader__date">{{ message.date }}</time>
          </button>
        </h3>
        <div v-show="message.key === activeKey" :id="panelId(message.key)"
          :ref="(element) => setPanelRef(message.key, element)"
          class="conversation-reader__detail" :aria-labelledby="summaryId(message.key)" role="region" />
      </li>
    </ol>

    <!-- Preserve the reader while a conversation reloads or changes selection. -->
    <div hidden>
      <Teleport :to="activePanel" :disabled="!activePanel">
        <slot />
      </Teleport>
    </div>
  </section>
</template>

<style scoped>
.conversation-reader {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--panel);
  color: var(--text);
}

.conversation-reader__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.conversation-reader__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 1rem;
  font-weight: 600;
}

.conversation-reader__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
}

.conversation-reader__stack {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.conversation-reader__message {
  flex: 0 0 auto;
  min-width: 0;
  border-bottom: 1px solid var(--border-soft);
}

.conversation-reader__message--active {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  flex: 1 0 0;
  min-height: min(30rem, 100%);
}

.conversation-reader__summary-heading {
  margin: 0;
  font: inherit;
}

.conversation-reader__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: start;
  font: inherit;
  cursor: pointer;
}

.conversation-reader__summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.conversation-reader__summary:hover {
  background: var(--control-hover-bg);
}

.conversation-reader__summary[aria-expanded="true"] {
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel2);
  cursor: default;
}

.conversation-reader__summary[aria-expanded="true"] .conversation-reader__chevron {
  rotate: 90deg;
}

.conversation-reader__chevron,
.conversation-reader__date {
  flex: 0 0 auto;
  color: var(--muted);
}

.conversation-reader__summary-text {
  display: grid;
  flex: 1;
  min-width: 0;
}

.conversation-reader__sender,
.conversation-reader__preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-reader__sender--unread {
  font-weight: 650;
}

.conversation-reader__unread-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  white-space: nowrap;
  clip-path: inset(50%);
}

.conversation-reader__preview,
.conversation-reader__date {
  color: var(--muted);
  font-size: 0.8125rem;
}

.conversation-reader__detail {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

@media (max-width: 639px) {
  .conversation-reader__toolbar {
    gap: 4px;
    padding: 4px 6px;
  }

  .conversation-reader__summary {
    gap: 6px;
    padding-inline: 8px;
  }
}

@media (pointer: coarse) {
  .conversation-reader__toolbar :deep(.app-icon-button) {
    width: 44px;
    height: 44px;
    flex-basis: 44px;
  }
}
</style>
