class PaletteState {
  open = $state(false);
  query = $state('');

  show(): void {
    this.query = '';
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  toggle(): void {
    if (this.open) {
      this.hide();
      return;
    }
    this.show();
  }
}

export const palette = new PaletteState();
