<script setup lang="ts">
/**
 * One message-list row. Owns the row's markup and styling so
 * every list surface renders the same row;
 * selection, focus and drag state come in as props and every interaction
 * is emitted back to the owner.
 */
import { computed, ref } from 'vue';
import { Paperclip, Star, Trash2 } from '@lucide/vue';

import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import type { JmapViewSort } from '../constants/states';
import { useSenderAvatars } from '../composables/useSenderAvatars';
import { baseThreadSubject } from '../utils/mail-threads';
import {
  ROW_HEIGHT,
  correspondentLabel,
  fmtDate,
  rowCorrespondent,
  rowTimestamp,
  type MessageRowLike,
} from '../utils/message-row-presentation';
import { resolveMessageTags, type MessageTagDefinition, type ResolvedTag } from '../utils/message-tags';
import { isScheduledMessage } from '../utils/scheduled-message';
import MessageTagStack from './MessageTagStack.vue';

const props = withDefaults(defineProps<{
  message: MessageRowLike & { id: number | string };
  index?: number;
  start?: number;
  size: number;
  focused?: boolean;
  cursor?: boolean;
  selected?: boolean;
  expanded?: boolean;
  readerControls?: string;
  selectionMixed?: boolean;
  conversationCount?: number;
  stackExpanded?: boolean;
  stackControls?: string;
  stackSubject?: string;
  nested?: boolean;
  dragging?: boolean;
  showsRecipients?: boolean;
  sort?: JmapViewSort;
  /** False on surfaces without multi-select: no checkbox is rendered. */
  selectable?: boolean;
  /**
   * Prefix of the row's DOM id (`${domIdPrefix}${message.id}`). Lists
   * that can show one folder side by side pass a per-list prefix so
   * `aria-activedescendant` and row anchors stay unique in the page.
   */
  domIdPrefix?: string;
  /** Use the standard Mail quick actions. Other views provide their own controls in the same overlay. */
  hoverActions?: boolean;
  context?: string;
  /** False where archiving is a no-op (the Archive folder): the overlay drops its Archive button. */
  archiveAction?: boolean;
  /** False in a tag view, whose rows live in many folders: the overlay drops Delete. */
  deleteAction?: boolean;
  /** Set while a row mutation is being saved locally. */
  actionsDisabled?: boolean;
  /** False where rows cannot be dragged to a folder (a tag view). */
  draggable?: boolean;
  /** True while this row's tag menu is open, for the Tag button's aria-expanded. */
  tagMenuOpen?: boolean;
  /**
   * Tag definitions that color the row's tag stack (MK-6.5). A keyword
   * without one draws as a neutral icon; names go in the stack's title.
   */
  tagDefinitions?: ReadonlyArray<MessageTagDefinition>;
  additionalTags?: ReadonlyArray<ResolvedTag>;
}>(), {
  focused: false,
  cursor: false,
  selected: false,
  expanded: undefined,
  stackExpanded: undefined,
  dragging: false,
  showsRecipients: false,
  sort: 'received',
  selectable: true,
  hoverActions: false,
  archiveAction: true,
  deleteAction: true,
  draggable: true,
  tagMenuOpen: false,
  domIdPrefix: 'msg-row-',
  tagDefinitions: () => [],
});

const emit = defineEmits<{
  (e: 'row-click', event: MouseEvent, trigger: HTMLButtonElement | null): void;
  (e: 'checkbox-click', event: MouseEvent): void;
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
  (e: 'star', flagged: boolean): void;
  /** Open the tag menu for this row, anchored to the button that raised it. */
  (e: 'tag', event: MouseEvent): void;
  /** A chip was clicked: the owner filters the list to that tag. */
  (e: 'archive'): void;
  (e: 'delete'): void;
  (e: 'toggle-stack'): void;
}>();

const { senderAvatar, onAvatarError } = useSenderAvatars();

const openButton = ref<HTMLButtonElement | null>(null);
const inFlow = computed(() => props.start === undefined);
const controlTabIndex = computed(() => inFlow.value ? undefined : -1);
const isUnread = computed(() => Number(props.message.is_seen) === 0);
const isFlagged = computed(() => Number(props.message.is_flagged) === 1);
const tags = computed(() => [
  ...resolveMessageTags(props.message.keywords_json, props.tagDefinitions),
  ...(props.additionalTags ?? []),
]);
const tagStackLabel = computed(() => (
  tags.value.length === 0 ? 'Tag' : `Tags: ${tags.value.map((tag) => tag.name).join(', ')}`
));
const correspondent = computed(() => rowCorrespondent(props.message, props.showsRecipients));
const avatar = computed(() => senderAvatar(correspondent.value));
const label = computed(() => correspondentLabel(props.message, props.showsRecipients));
const dateText = computed(() => fmtDate(rowTimestamp(props.message, props.sort)));
const preview = computed(() => [props.context, props.message.preview].filter(Boolean).join(' · '));
const rowKind = computed(() => props.conversationCount && props.conversationCount > 1 ? 'conversation' : 'message');
const hasStack = computed(() => inFlow.value && props.stackExpanded !== undefined && rowKind.value === 'conversation');
const readingStack = computed(() => hasStack.value && props.expanded);
const expandedStack = computed(() => hasStack.value && (props.stackExpanded || readingStack.value));
const subject = computed(() => props.message.subject || '(no subject)');
const displaySubject = computed(() => expandedStack.value && props.stackSubject !== undefined
  ? props.stackSubject || '(no subject)' : subject.value);
const sharedSubject = computed(() => rowKind.value === 'message' && props.stackSubject !== undefined
  && baseThreadSubject(props.message.subject) === baseThreadSubject(props.stackSubject));
const minRowHeight = computed(() => expandedStack.value ? undefined
  : `${sharedSubject.value ? Math.min(props.size, ROW_HEIGHT) : props.size}px`);
const rowTitle = computed(() => expandedStack.value ? displaySubject.value : `${subject.value}, ${label.value}`);
const rowLabel = computed(() => [
  label.value,
  subject.value,
  dateText.value,
  isUnread.value ? 'Unread' : '',
  isFlagged.value ? 'Starred' : '',
  Number(props.message.has_attachment) === 1 ? 'Has attachments' : '',
  tags.value.length > 0 ? tagStackLabel.value : '',
].filter(Boolean).join(', '));
</script>

<template>
  <li
    :id="`${domIdPrefix}${encodeURIComponent(message.id)}`"
    :data-index="index"
    :role="inFlow ? undefined : 'row'"
    :aria-rowindex="index === undefined ? undefined : index + 1"
    :aria-label="inFlow ? undefined : rowLabel"
    :aria-selected="inFlow ? undefined : selected"
    :class="{
      'is-focused': focused,
      'is-cursor': cursor,
      'is-selected': selected,
      'is-partially-selected': selectionMixed,
      'is-dragging': dragging,
      'is-unread': isUnread,
      'is-unselectable': !selectable,
      'msg-list__row--stack': hasStack,
      'msg-list__row--nested': nested,
    }"
    :style="inFlow ? { minHeight: minRowHeight, '--message-stack-height': hasStack ? `${size}px` : undefined } : {
      position: 'absolute',
      top: '0px',
      left: '0px',
      right: '0px',
      transform: `translateY(${start}px)`,
      height: size + 'px',
    }"
  >
    <div
      class="msg-list__item"
      :class="{
        'msg-list__item--with-controls': hoverActions || $slots.controls,
        'msg-list__item--in-flow': inFlow,
        'msg-list__item--stack': hasStack,
        'msg-list__item--stack-expanded': expandedStack,
        'msg-list__item--shared-subject': sharedSubject,
        'has-tag-menu': tagMenuOpen,
      }"
      :role="inFlow ? undefined : 'gridcell'"
      :draggable="draggable && !isScheduledMessage(message)"
      @click="emit('row-click', $event, openButton)"
      @dragstart="emit('dragstart', $event)"
      @dragend="emit('dragend', $event)"
    >
      <button
        ref="openButton"
        type="button"
        class="msg-list__open"
        data-message-control
        :tabindex="controlTabIndex"
        :aria-current="inFlow && focused ? true : undefined"
        :aria-expanded="expanded"
        :aria-controls="readerControls"
        :aria-label="`Open ${rowKind}: ${rowTitle}${isUnread ? ', unread' : ''}`"
        :title="expandedStack ? `Open conversation: ${displaySubject}` : context ? preview : undefined"
      />
      <div v-if="selectable" class="msg-list__state">
        <label class="msg-list__check" draggable="false" @click.stop>
          <input
            type="checkbox"
            data-message-control
            :tabindex="controlTabIndex"
            :aria-label="`Select ${rowKind}: ${rowTitle}`"
            :checked="selected"
            :indeterminate.prop="Boolean(selectionMixed)"
            @click="emit('checkbox-click', $event)"
          />
        </label>
      </div>
      <div
        v-if="!expandedStack"
        class="msg-list__avatar"
        :class="{ 'msg-list__avatar--unread': isUnread }"
        :style="avatar.style"
        aria-hidden="true"
      >
        <img
          v-if="avatar.imageUrl"
          class="msg-list__avatar-image"
          :src="avatar.imageUrl"
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          @error="onAvatarError(correspondent)"
        />
        <span>{{ avatar.initials }}</span>
      </div>
      <div class="msg-list__content">
        <div class="msg-list__summary">
          <span v-if="!expandedStack" class="msg-list__from">{{ label }}</span>
          <span v-if="!sharedSubject" class="msg-list__subject">{{ displaySubject }}</span>
          <span v-if="!expandedStack" class="msg-list__icons">
            <Star v-if="isFlagged" :size="13" :stroke-width="2" class="msg-list__star" />
            <Paperclip v-if="Number(message.has_attachment) === 1" :size="13" :stroke-width="1.75" class="msg-list__attach" />
            <MessageTagStack
              v-if="tags.length > 0"
              :tags="tags"
              :title="tagStackLabel"
              data-row-tags
            />
          </span>
          <span v-if="!expandedStack" class="msg-list__date">{{ dateText }}</span>
        </div>
        <p v-if="preview && !expandedStack" class="msg-list__preview">
          {{ preview }}
        </p>
      </div>
      <div v-if="hoverActions || $slots.controls" class="msg-list__row-controls" draggable="false" @click.stop>
        <div v-if="hoverActions" class="msg-list__actions">
          <button
            type="button"
            class="msg-list__action msg-list__action--tag"
            :class="{ 'is-tagged': tags.length > 0 }"
            :tabindex="controlTabIndex"
            data-message-control
            :title="tagStackLabel"
            :aria-label="tagStackLabel"
            aria-haspopup="dialog"
            :aria-expanded="tagMenuOpen"
            :disabled="actionsDisabled"
            data-row-tags
            @click="emit('tag', $event)"
          >
            <MessageTagStack :tags="tags" />
          </button>
          <button
            type="button"
            class="msg-list__action msg-list__action--star"
            :class="{ 'msg-list__action--starred': isFlagged }"
            :tabindex="controlTabIndex"
            data-message-control
            :title="isFlagged ? 'Unstar' : 'Star'"
            :aria-label="isFlagged ? 'Unstar' : 'Star'"
            :aria-pressed="isFlagged"
            :disabled="actionsDisabled"
            @click="emit('star', !isFlagged)"
          >
            <Star :size="17" :stroke-width="1.75" :fill="isFlagged ? '#facc15' : 'none'" />
          </button>
          <button
            v-if="archiveAction"
            type="button"
            class="msg-list__action"
            :tabindex="controlTabIndex"
            data-message-control
            title="Archive"
            aria-label="Archive"
            :disabled="actionsDisabled"
            @click="emit('archive')"
          >
            <span class="msg-list__action-icon--folder" aria-hidden="true" v-html="archiveIcon" />
          </button>
          <button
            v-if="deleteAction"
            type="button"
            class="msg-list__action msg-list__action--danger"
            :tabindex="controlTabIndex"
            data-message-control
            title="Delete"
            aria-label="Delete"
            :disabled="actionsDisabled"
            @click="emit('delete')"
          >
            <Trash2 :size="18" :stroke-width="1.65" />
          </button>
        </div>
        <slot name="controls" />
      </div>
    </div>
    <div v-if="hasStack" class="msg-list__stack-edge" :class="{
      'msg-list__stack-edge--expanded': expandedStack,
      'msg-list__stack-edge--deep': (conversationCount ?? 0) > 2,
    }">
      <button type="button" class="msg-list__stack-toggle" data-message-control
        :aria-label="readingStack ? 'Collapse conversation' : `${stackExpanded ? 'Hide' : 'Show'} conversation messages`"
        :title="readingStack ? 'Collapse conversation' : `${stackExpanded ? 'Hide' : 'Show'} conversation messages`"
        :aria-expanded="expandedStack" :aria-controls="readingStack ? readerControls : stackControls"
        @click.stop="readingStack ? emit('row-click', $event, openButton) : emit('toggle-stack')" />
    </div>
    <slot name="after-row" />
  </li>
</template>

<style scoped>
/* Fastmail model: the focused row (currently being viewed) gets the
 * solid accent background. Selection state is communicated by the
 * checkbox itself; we tint the row very softly so the user can scan
 * a column of selected rows without it competing with the "what
 * am I reading" highlight. */
.msg-list__items li.is-focused > .msg-list__item { background: var(--rowActive); }
.msg-list__items li.is-selected > .msg-list__item {
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}
.msg-list__items li.is-selected.is-focused > .msg-list__item {
  background: var(--rowActive);
}
.msg-list__items li.is-dragging > .msg-list__item {
  opacity: 0.55;
}
.msg-list__items li.is-unread > .msg-list__item .msg-list__from,
.msg-list__items li.is-unread > .msg-list__item .msg-list__subject {
  font-weight: 600;
  color: var(--text);
}

.msg-list__item {
  --row-padding-block: 7px;
  --row-padding-start: 12px;
  --row-padding-end: 14px;
  position: relative;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  column-gap: 10px;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: var(--row-padding-block) var(--row-padding-end) var(--row-padding-block) var(--row-padding-start);
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  font: inherit;
  color: inherit;
  transition: background 0.06s ease;
  /* Stops Shift-click from accidentally selecting subject text as
   * the user extends a range — the native text-selection range
   * appears on top of the row highlight and is very ugly. */
  user-select: none;
  -webkit-user-select: none;
}
.msg-list__item:hover,
.msg-list__item:focus-within,
.msg-list__item.has-tag-menu { background: var(--rowHover); }
.msg-list__item--with-controls { background: var(--panel); }
.msg-list__item--in-flow {
  min-height: inherit;
}
.msg-list__row--stack {
  position: relative;
  padding-block-start: 10px;
}
.msg-list__row--nested { margin-inline-start: 14px; border-inline-start: 1px solid var(--border); }
.msg-list__item.msg-list__item--stack {
  min-height: calc(var(--message-stack-height) - 10px);
  width: auto;
  margin-inline: 6px;
  padding: calc(var(--row-padding-block) - 2px) calc(var(--row-padding-end) - 7px)
    max(0px, calc(var(--row-padding-block) - 8px)) calc(var(--row-padding-start) - 7px);
  border: 1px solid var(--control-border);
  border-radius: 7px;
}
.msg-list__item--stack .msg-list__open { border-radius: inherit; }
.msg-list__stack-edge {
  position: absolute;
  inset: 0 0 auto;
  height: 10px;
  pointer-events: none;
}
.msg-list__stack-edge:not(.msg-list__stack-edge--expanded)::before,
.msg-list__stack-edge--deep:not(.msg-list__stack-edge--expanded)::after {
  content: '';
  position: absolute;
  inset: 5px 12px auto;
  height: 5px;
  border: 1px solid var(--control-border);
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  background: var(--panel2);
  pointer-events: none;
}
.msg-list__stack-edge--deep:not(.msg-list__stack-edge--expanded)::after {
  inset: 1px 19px auto;
  height: 4px;
}
.msg-list__stack-toggle {
  position: absolute;
  z-index: 1;
  inset: 0 12px auto;
  height: 10px;
  padding: 0;
  border: 0;
  border-radius: 6px 6px 0 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.msg-list__stack-toggle:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.msg-list__stack-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.msg-list__scroller:focus-visible .is-cursor .msg-list__item::after,
.msg-list__item:has(> .msg-list__open:focus-visible)::after {
  content: '';
  position: absolute;
  z-index: 3;
  inset: 0;
  border-radius: inherit;
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  pointer-events: none;
}
.msg-list__open {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}
.msg-list__state,
.msg-list__avatar,
.msg-list__content {
  pointer-events: none;
}
.msg-list__check { pointer-events: auto; }
.msg-list__content {
  grid-column: 2;
  min-width: 0;
}
.msg-list__open:focus-visible { outline: none; }
.msg-list__action:focus-visible,
.msg-list__check input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.msg-list__item:focus-within .msg-list__check { opacity: 1; }

/* Both Mail and Attention place their controls over the summary. This
   keeps the same text layout regardless of which commands are present. */
.msg-list__row-controls {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  inset-inline-end: var(--row-padding-end);
  inset-block-start: 50%;
  translate: 0 -50%;
  border-radius: 6px;
  background: inherit;
}
.msg-list__item--stack > .msg-list__row-controls {
  inset-inline-end: calc(var(--row-padding-end) - 7px);
}
.msg-list__row-controls::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-end: 100%;
  width: 12px;
  background: inherit;
  mask-image: linear-gradient(to right, transparent, #000);
  pointer-events: none;
}
.msg-list__row-controls:dir(rtl)::before {
  mask-image: linear-gradient(to left, transparent, #000);
}
.msg-list__item:has(.msg-list__preview) > .msg-list__row-controls {
  inset-block-start: calc(50% - 10px);
}
.msg-list--card .msg-list__item:has(.msg-list__preview) > .msg-list__row-controls {
  inset-block-start: var(--row-padding-block);
  translate: none;
}
@media (hover: hover) and (pointer: fine) {
  .msg-list__item:not(:hover, :focus-within, .has-tag-menu, :has(details[open])) > .msg-list__row-controls {
    opacity: 0;
    pointer-events: none;
  }
  /* Mail enters the row through the checkbox with F2, then exposes these
     arrow-key controls. Attention's slotted buttons stay in the Tab order. */
  .msg-list__item:not(:hover, :focus-within, .has-tag-menu) .msg-list__actions {
    visibility: hidden;
  }
  .msg-list__item--with-controls:is(:hover, :focus-within, .has-tag-menu, :has(details[open]))
    .msg-list__summary :is(.msg-list__icons, .msg-list__date) {
    visibility: hidden;
  }
}
.msg-list__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.msg-list__action {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
}
.msg-list__action--tag { width: auto; min-width: 34px; padding: 0 6px; }
.msg-list__action:hover:where(:not(:disabled)) { background: var(--control-hover-bg); color: var(--text); }
.msg-list__action--starred, .msg-list__action--starred:hover { color: var(--folder-icon-color); }
.msg-list__action--danger:hover:where(:not(:disabled)) { background: var(--error-bg); color: var(--error-fg); }
.msg-list__action:disabled { opacity: 0.35; cursor: default; }
@media (max-width: 639px) and (pointer: coarse) {
  .msg-list--card .msg-list__item--stack:not(.msg-list__item--stack-expanded) {
    min-height: var(--message-stack-height);
  }
  .msg-list--card .msg-list__item:not(.msg-list__item--stack-expanded) > .msg-list__row-controls {
    inset-block: auto 2px;
    translate: none;
    --row-touch-action-height: 28px;
  }
  .msg-list__action { min-width: 44px; height: var(--row-touch-action-height, 44px); }
  .msg-list__action:not(.msg-list__action--star, .msg-list__action--tag) {
    display: none;
  }
  .msg-list__item:has(.msg-list__actions) .msg-list__summary :is(.msg-list__star, [data-row-tags]) {
    visibility: hidden;
  }
}
.msg-list__action-icon--folder {
  display: block;
  width: 20px;
  height: 20px;
}
.msg-list__action-icon--folder :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.msg-list__action-icon--folder :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__action-icon--folder :deep([fill="context-stroke"]) {
  fill: currentColor;
}

.msg-list__state {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
}
.msg-list__check {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.08s ease;
}
.msg-list__check input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

.msg-list__item:hover .msg-list__check,
.msg-list__items li.is-selected > .msg-list__item .msg-list__check,
.msg-list__items li.is-partially-selected > .msg-list__item .msg-list__check {
  opacity: 1;
}
.msg-list__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 22%, transparent);
}
.msg-list__avatar-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.msg-list__avatar--unread::after {
  content: '';
  position: absolute;
  inset-inline-end: -1px;
  inset-block-end: -1px;
  box-sizing: border-box;
  width: 11px;
  height: 11px;
  border: 2px solid var(--panel);
  border-radius: 50%;
  background: var(--accent);
}

.msg-list__summary {
  display: grid;
  grid-template-columns: clamp(86px, 28%, 200px) minmax(0, 1fr) auto auto;
  grid-template-areas: "from subject icons date";
  align-items: baseline;
  column-gap: 8px;
}
.msg-list__from {
  grid-area: from;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__date {
  grid-area: date;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.msg-list__subject {
  grid-area: subject;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__icons {
  grid-area: icons;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  min-width: 0;
}

.msg-list__star {
  color: var(--folder-icon-color);
  fill: #facc15;
}
.msg-list__preview {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.msg-list--card .msg-list__item {
  --row-padding-block: 10px;
  --row-padding-start: 12px;
  --row-padding-end: 12px;
  align-items: start;
  column-gap: 9px;
}
.msg-list__state, .msg-list__avatar { grid-area: 1 / 1; }
.msg-list__state { z-index: 1; }
.msg-list__check input { justify-self: start; align-self: end; }
@media (hover: hover) and (min-width: 640px) {
  .msg-list__check input { justify-self: center; align-self: center; }
  .msg-list__item:has(.msg-list__check):is(:hover, :focus-within) .msg-list__avatar,
  li:is(.is-selected, .is-partially-selected) .msg-list__item:has(.msg-list__check) .msg-list__avatar {
    opacity: 0.2;
  }
}
@media (hover: none) {
  .msg-list__check { opacity: 1; }
}
.msg-list--card .msg-list__summary {
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "from icons date"
    "subject subject subject";
  row-gap: 2px;
}
.msg-list--card .msg-list__from,
.msg-list--card .msg-list__subject {
  font-size: 13px;
}
.msg-list--card .msg-list__subject {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.msg-list--card .msg-list__preview {
  margin-top: 3px;
  -webkit-line-clamp: 1;
}
.msg-list__item--shared-subject .msg-list__from { grid-column-end: subject-end; }
.msg-list--card .msg-list__item--shared-subject { align-items: center; }
.msg-list--card .msg-list__item--shared-subject .msg-list__from { grid-column-end: from-end; }
.msg-list--card .msg-list__item--shared-subject .msg-list__summary { row-gap: 0; }

/* The expanded stack keeps its group controls above the individual messages. */
.msg-list__item.msg-list__item--stack-expanded {
  min-height: 36px;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  padding-block: 0;
}
.msg-list__item--stack-expanded .msg-list__check { opacity: 1; }
.msg-list__item.msg-list__item--stack-expanded .msg-list__summary {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: 'subject';
  align-items: center;
  row-gap: 0;
}
.msg-list__item--stack-expanded .msg-list__subject { display: block; white-space: nowrap; }

@media (max-width: 639px) {
  .msg-list__check {
    opacity: 1;
  }
}
</style>
