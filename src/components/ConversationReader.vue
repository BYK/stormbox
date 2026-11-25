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
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ArrowLeft, ChevronDown } from '@lucide/vue';

import { fmtDate } from '../utils/message-row-presentation';
import AppIconButton from './AppIconButton.vue';

const props = withDefaults(defineProps<{
  subject: string | null | undefined;
  messages: readonly ConversationReaderMessage[];
  activeKey: string;
  backLabel?: string;
}>(), { backLabel: 'Back to messages' });

const emit = defineEmits<{
  back: [];
  expand: [key: string];
}>();

const id = useId();
const titleId = `${id}-subject`;
const stack = ref<HTMLOListElement | null>(null);
const expanded = ref(new Set<string>());
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
function toggleMessage(key: string) {
  if (expanded.value.has(key)) expanded.value.delete(key);
  else {
    expanded.value.add(key);
    emit('expand', key);
  }
}

watch(() => props.messages, (items) => {
  const keys = new Set(items.map(({ key }) => key));
  for (const key of expanded.value) if (!keys.has(key)) expanded.value.delete(key);
});

watch(() => props.activeKey, async (key) => {
  if (!key) return;
  expanded.value.add(key);
  await nextTick();
  const list = stack.value;
  const heading = document.getElementById(summaryId(key));
  if (!list || !heading) return;
  const top = heading.getBoundingClientRect().top - list.getBoundingClientRect().top;
  if (top < 0 || top > list.clientHeight / 3) list.scrollTop += top;
}, { immediate: true });
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
        :class="{ 'conversation-reader__message--expanded': expanded.has(message.key) }">
        <h3 class="conversation-reader__summary-heading">
          <button :id="summaryId(message.key)" type="button" class="conversation-reader__summary"
            :aria-controls="panelId(message.key)" :aria-expanded="expanded.has(message.key)"
            @click="toggleMessage(message.key)">
            <span class="conversation-reader__summary-text">
              <span class="conversation-reader__sender" :class="{ 'conversation-reader__sender--unread': message.unread }">
                {{ message.sender || '(no sender)' }}<span v-if="message.unread" class="conversation-reader__unread-label">, unread</span>
              </span>
              <span v-if="message.preview && !expanded.has(message.key)" class="conversation-reader__preview">{{ message.preview }}</span>
            </span>
            <time v-if="message.date" :datetime="message.dateTime" class="conversation-reader__date">{{ message.date }}</time>
            <ChevronDown :size="15" aria-hidden="true" class="conversation-reader__chevron" />
          </button>
        </h3>
        <div v-show="expanded.has(message.key)" :id="panelId(message.key)"
          class="conversation-reader__detail" :aria-labelledby="summaryId(message.key)" role="region">
          <slot v-if="expanded.has(message.key)" :message-key="message.key" />
        </div>
      </li>
    </ol>

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
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.conversation-reader__stack {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  isolation: isolate;
  overscroll-behavior-y: contain;
  min-height: 0;
  margin: 0;
  padding: 8px;
  list-style: none;
}

.conversation-reader__message {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--panel);
}

.conversation-reader__message--expanded + .conversation-reader__message { margin-block-start: 6px; }
/* A collapsed card tucks behind the next message in chronological order. */
.conversation-reader__message:not(.conversation-reader__message--expanded):has(+ .conversation-reader__message) {
  isolation: isolate;
  margin-block-end: -6px;
  margin-inline: 6px;
  padding-block-end: 6px;
  background: var(--panel2);
}
.conversation-reader__message:not(.conversation-reader__message--expanded):has(
  + .conversation-reader__message:not(.conversation-reader__message--expanded) + .conversation-reader__message
) {
  margin-inline: 12px;
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
  min-height: 40px;
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
}

.conversation-reader__summary[aria-expanded="true"] .conversation-reader__chevron {
  rotate: 180deg;
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

.conversation-reader__detail { min-width: 0; }

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
