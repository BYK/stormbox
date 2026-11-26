<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { X } from '@lucide/vue';
import { useModalFocus } from '../composables/useModalFocus';
import { UNTIL_NEW_ACTIVITY, localSnoozeInput, snoozeChoices } from '../triage/snooze-time';
import AppButton from './AppButton.vue';
import AppIconButton from './AppIconButton.vue';

const props = defineProps<{ returnFocus: HTMLElement }>();
const emit = defineEmits<{ close: []; select: [until: number] }>();
const surface = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const now = ref(Date.now());
const choices = computed(() => snoozeChoices(now.value));
const custom = ref(false);
const dateTime = ref('');
const error = ref('');
const id = useId();
const timeLabel = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

useModalFocus(surface, { containTab: true, restoreTo: () => props.returnFocus });

function select(until: number) {
  if (until <= Date.now()) {
    now.value = Date.now();
    error.value = 'Choose a time in the future.';
    return;
  }
  emit('select', until);
}

async function showCustom() {
  custom.value = true;
  error.value = '';
  await nextTick();
  input.value?.focus();
}

function selectCustom() {
  const until = new Date(dateTime.value).getTime();
  if (!Number.isFinite(until) || localSnoozeInput(until) !== dateTime.value) {
    error.value = 'Choose a valid local date and time.';
    return;
  }
  select(until);
}
</script>

<template>
  <Teleport to="body">
    <div class="attention-snooze__backdrop" @click.self="emit('close')">
      <form ref="surface" class="attention-snooze" role="dialog" aria-modal="true" :aria-labelledby="`${id}-title`"
        tabindex="-1" @keydown.esc.prevent.stop="emit('close')" @submit.prevent="selectCustom">
        <header class="attention-snooze__header">
          <h2 :id="`${id}-title`">Snooze until</h2>
          <AppIconButton aria-label="Cancel snooze setup" title="Cancel" @click="emit('close')">
            <X :size="18" aria-hidden="true" />
          </AppIconButton>
        </header>
        <div class="attention-snooze__durations" aria-label="Snooze for" role="group">
          <button v-for="choice in choices.durations" :key="choice.short" type="button" class="app-dropdown__item"
            :aria-label="choice.label" @click="select(choice.until)">
            <span>{{ choice.short }}</span>
            <time :datetime="new Date(choice.until).toISOString()">{{ timeLabel.format(choice.until) }}</time>
          </button>
        </div>
        <button v-for="choice in choices.calendar" :key="choice.label" type="button" class="app-dropdown__item attention-snooze__choice"
          @click="select(choice.until)">
          <span>{{ choice.label }}</span>
          <time :datetime="new Date(choice.until).toISOString()">{{ dayLabel.format(choice.until) }}</time>
        </button>
        <button type="button" class="app-dropdown__item attention-snooze__choice" @click="select(UNTIL_NEW_ACTIVITY)">
          <span>Until new mail needs attention</span>
        </button>
        <button v-if="!custom" type="button" class="app-dropdown__item attention-snooze__choice" @click="showCustom">Custom…</button>
        <div v-else class="attention-snooze__custom">
          <label :for="`${id}-time`">Date and time</label>
          <input :id="`${id}-time`" ref="input" v-model="dateTime" type="datetime-local" :aria-invalid="error ? true : undefined"
            :aria-describedby="error ? `${id}-error` : undefined" @input="error = ''" />
          <AppButton form-action="submit">Snooze</AppButton>
        </div>
        <p v-if="error" :id="`${id}-error`" class="attention-snooze__error" role="alert">{{ error }}</p>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.attention-snooze__backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 12px;
  background: rgb(0 0 0 / 45%);
}
.attention-snooze {
  width: min(100%, 350px);
  max-height: min(560px, 90dvh);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
}
.attention-snooze__header { display: flex; align-items: center; justify-content: space-between; }
.attention-snooze__header h2 { margin: 0 0 0 8px; font-size: 1rem; }
.attention-snooze__durations { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin: 6px 0; }
.attention-snooze__durations button { grid-template-columns: minmax(0, 1fr); text-align: center; gap: 2px; }
.attention-snooze__choice { width: 100%; grid-template-columns: minmax(0, 1fr) auto; }
.attention-snooze time { color: var(--muted); font-size: 12px; }
.attention-snooze__custom { display: grid; gap: 8px; padding: 8px; font-size: 13px; }
.attention-snooze__custom input { min-width: 0; padding: 8px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--panel); color: var(--text); }
.attention-snooze__error { margin: 4px 8px; font-size: 13px; color: var(--error-fg); }
</style>
