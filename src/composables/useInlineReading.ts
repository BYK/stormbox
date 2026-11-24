import { createSharedComposable, useStorage } from '@vueuse/core';

export const useInlineReading = createSharedComposable(() => useStorage('stormbox.mail.inline-reading', false));
