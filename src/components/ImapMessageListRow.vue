<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';

import type { imapEntry } from '../composables/useImapReader';
import { requestTagManager } from '../composables/useTagManagerRequest';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { gmailLabelTags, imapTagPatch } from '../utils/imap-message-tags';
import { ROW_HEIGHT, type MessageRowLike } from '../utils/message-row-presentation';
import { resolveMessageTags, type MessageTagDefinition } from '../utils/message-tags';
import AttentionRowMenu from './AttentionRowMenu.vue';
import MessageListRow from './MessageListRow.vue';
import TagPickerPopover, { type PopoverAnchor } from './TagPickerPopover.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  entry: ReturnType<typeof imapEntry>;
  presentation?: MessageRowLike & { id: number | string };
  definitions: ReadonlyArray<MessageTagDefinition>;
  size?: number;
  focused?: boolean;
  showsRecipients?: boolean;
  context?: string;
  domIdPrefix?: string;
  disabled?: boolean;
  hoverActions?: boolean;
  canArchive?: boolean;
  canTrash?: boolean;
  canJunk?: boolean;
}>(), {
  size: ROW_HEIGHT,
  domIdPrefix: 'imap-mail-row-',
  canArchive: true,
  canTrash: true,
});

const emit = defineEmits<{
  'row-click': [event: MouseEvent, trigger: HTMLButtonElement | null];
  action: [action: ImapAttentionAction];
}>();

const message = computed(() => props.presentation ?? props.entry.presentation);
const labels = computed(() => props.entry.row.labels ?? []);
const hasGmailLabels = computed(() => props.entry.row.gmailLabels ?? labels.value.length > 0);
const canArchive = computed(() => props.canArchive
  && (!hasGmailLabels.value || props.entry.location.mailbox.toUpperCase() === 'INBOX'));
const appliedGmailLabels = computed(() => hasGmailLabels.value && labels.value.length > 0
  ? gmailLabelTags(labels.value, props.definitions)
  : []);

const tagPickerUsed = ref(false);
const tagAnchor = ref<PopoverAnchor | null>(null);
const tagTrigger = shallowRef<HTMLElement | null>(null);
const tagReturnFocus = shallowRef<HTMLElement | null>(null);
const pickerTargets = computed(() => [props.entry.presentation]);
const keywordTags = computed(() => resolveMessageTags(props.entry.presentation.keywords_json, props.definitions));
const pickerDefinitions = computed(() => hasGmailLabels.value
  ? props.definitions.filter(({ keyword }) => keywordTags.value.some((tag) => tag.keyword === keyword))
  : props.definitions);
const gmailTags = computed(() => tagAnchor.value && hasGmailLabels.value
  ? gmailLabelTags(labels.value, props.definitions, props.entry.account.messages.flatMap((row) => row.labels ?? []))
  : []);

async function openTags(trigger: HTMLElement, toggle = false) {
  if (props.disabled) return;
  if (tagAnchor.value && tagTrigger.value === trigger) {
    closeTags();
    return;
  }
  tagReturnFocus.value = trigger;
  tagTrigger.value = toggle ? trigger : null;
  tagPickerUsed.value = true;
  const entryId = props.entry.id;
  await nextTick();
  if (!trigger.isConnected || props.entry.id !== entryId) return;
  const { top, left, width, height } = trigger.getBoundingClientRect();
  tagAnchor.value = { top, left, width, height };
}

function onTagButton(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) void openTags(event.currentTarget, true);
}

function closeTags() {
  tagAnchor.value = null;
}

watch(() => props.entry.id, closeTags);

function run(action: ImapAttentionAction) {
  if (!props.disabled) emit('action', action);
}

function setTag(keyword: string, on: boolean) {
  run({ type: 'tags', tags: imapTagPatch(keyword, on, gmailTags.value) });
}

function clearTags() {
  run({
    type: 'tags',
    tags: { remove: keywordTags.value.map(({ keyword }) => keyword), removeLabels: [...labels.value] },
  });
}

function manageTags() {
  closeTags();
  requestTagManager();
}
</script>

<template>
  <MessageListRow
    v-bind="$attrs"
    :message="message"
    :size="size"
    :dom-id-prefix="domIdPrefix"
    :focused="focused"
    :context="context"
    :selectable="false"
    unread-on-avatar
    :draggable="false"
    :shows-recipients="showsRecipients"
    :tag-definitions="definitions"
    :additional-tags="appliedGmailLabels"
    :hover-actions="hoverActions"
    :tag-menu-open="!!tagAnchor"
    :archive-action="canArchive"
    :delete-action="canTrash"
    :actions-disabled="disabled"
    @row-click="(event, trigger) => emit('row-click', event, trigger)"
    @star="run({ type: 'star', value: $event })"
    @tag="onTagButton"
    @archive="run({ type: 'archive' })"
    @delete="run({ type: 'trash' })"
  >
    <template #controls>
      <div class="msg-list__row-controls" draggable="false" @click.stop>
        <slot name="controls" />
        <AttentionRowMenu
          :row="message"
          :disabled="disabled"
          :can-archive="canArchive"
          :can-trash="canTrash"
          :can-junk="canJunk"
          can-tag
          @action="run"
          @tag="openTags($event)"
        />
      </div>
    </template>
    <template v-if="$slots['after-row']" #after-row>
      <slot name="after-row" />
    </template>
  </MessageListRow>
  <TagPickerPopover
    v-if="tagPickerUsed"
    :anchor="tagAnchor"
    :trigger="tagTrigger"
    :return-focus="tagReturnFocus"
    :targets="pickerTargets"
    :definitions="pickerDefinitions"
    :additional-tags="gmailTags"
    :busy="disabled"
    @close="closeTags"
    @toggle="setTag"
    @clear="clearTags"
    @manage="manageTags"
  />
</template>
