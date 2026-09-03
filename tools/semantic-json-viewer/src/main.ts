const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const selected = tab.dataset.tab;
    if (!selected) {
      return;
    }

    for (const other of tabs) {
      const active = other === tab;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-selected", active ? "true" : "false");
    }

    for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
      panel.classList.toggle("is-hidden", panel.dataset.panel !== selected);
    }
  });
}
