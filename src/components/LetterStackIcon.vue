<template>
  <span class="letter-stack" aria-hidden="true"><span /></span>
</template>

<style scoped>
.letter-stack {
  position: relative;
  display: inline-block;
  flex: 0 0 16px;
  inline-size: 16px;
  block-size: 13px;
}
.letter-stack::before,
.letter-stack::after,
.letter-stack > span {
  content: '';
  position: absolute;
  inset-inline: 1px;
  block-size: 7px;
  box-sizing: border-box;
  border: 1px solid currentColor;
  border-radius: 2px;
  background: var(--panel);
}
.letter-stack::before { inset-block-start: 0; opacity: .55; }
.letter-stack::after { inset-block-start: 3px; }
.letter-stack > span { inset-block-start: 6px; z-index: 1; }
</style>
