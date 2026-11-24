<template>
  <section class="mail-inline-reader" data-inline-mail-reader role="region" aria-label="Inline mail reader">
    <slot />
  </section>
</template>

<style scoped>
.mail-inline-reader {
  box-sizing: border-box;
  height: var(--inline-reader-height, clamp(20rem, 60dvh, 36rem));
  min-width: 0;
  overflow: hidden;
  background: var(--panel);
  border-block-end: 1px solid var(--border);
}
</style>
