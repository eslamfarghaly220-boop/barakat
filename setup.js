const setupForm = document.querySelector("#setupForm");
const setupMessage = document.querySelector("#setupMessage");

document.querySelectorAll("[data-tilt]").forEach((element) => {
  element.addEventListener("mousemove", (event) => {
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.setProperty("--tilt-x", `${(-y * 8).toFixed(2)}deg`);
    element.style.setProperty("--tilt-y", `${(x * 10).toFixed(2)}deg`);
  });

  element.addEventListener("mouseleave", () => {
    element.style.setProperty("--tilt-x", "0deg");
    element.style.setProperty("--tilt-y", "0deg");
  });
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setupMessage.textContent = "";
  const submitButton = setupForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  const formData = new FormData(setupForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      setupMessage.textContent = result.error || "تعذر إعداد النظام.";
      submitButton.disabled = false;
      return;
    }

    window.location.href = "/";
  } catch (error) {
    setupMessage.textContent = "تعذر الاتصال بالخادم.";
    submitButton.disabled = false;
  }
});
