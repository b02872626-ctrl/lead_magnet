const form = document.querySelector("#lead-form");
const statusBox = document.querySelector("#form-status");
const submitButton = form?.querySelector('button[type="submit"]');
const phoneInput = document.querySelector("#phone");
const defaultButtonText = submitButton?.textContent || "Submit";

const requiredFieldIds = [
  "fullName",
  "companyName",
  "email",
  "phone",
  "companyScale",
  "position",
];

const fieldMap = Object.fromEntries(
  requiredFieldIds
    .map((id) => {
      const input = document.getElementById(id);
      const control = input?.closest(".field-control");
      const error = document.getElementById(`${id}-error`);

      if (!input || !control || !error) {
        return null;
      }

      return [id, { input, control, error }];
    })
    .filter(Boolean)
);

for (const fieldId of requiredFieldIds) {
  const field = fieldMap[fieldId];

  if (!field) {
    continue;
  }

  const eventName = field.input.tagName === "SELECT" ? "change" : "input";
  field.input.addEventListener(eventName, () => validateField(fieldId));
}

if (phoneInput) {
  phoneInput.addEventListener("input", () => {
    const digits = phoneInput.value.replace(/\D/g, "");

    if (digits.length > 9) {
      phoneInput.value = digits.slice(0, 9);
      setFieldError("phone", "Use only 9 digits");
      return;
    }

    phoneInput.value = digits;
    validateField("phone");
  });
}

if (form && statusBox && submitButton) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const hasValidationErrors = !validateForm();

    if (hasValidationErrors) {
      setStatus("", "");
      return;
    }

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    setStatus("", "");
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.message || "Something went wrong.");
      }

      if (response.status === 202 || result.emailSent === false) {
        setStatus(result.message, "is-warning");
      } else {
        setStatus("Please check your email.", "is-success");
        form.reset();
        clearAllFieldErrors();
      }
    } catch (error) {
      setStatus(
        error.message || "We could not process the form right now. Please try again.",
        "is-error"
      );
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = defaultButtonText;
    }
  });
}

function validateForm() {
  let isValid = true;

  for (const fieldId of requiredFieldIds) {
    const fieldIsValid = validateField(fieldId, { showRequired: true });
    isValid = fieldIsValid && isValid;
  }

  return isValid;
}

function validateField(fieldId, options = {}) {
  const { showRequired = false } = options;
  const field = fieldMap[fieldId];

  if (!field) {
    return true;
  }

  const value = field.input.value.trim();

  if (!value) {
    if (showRequired) {
      setFieldError(fieldId, "Required");
    } else {
      clearFieldError(fieldId);
    }

    return false;
  }

  if (fieldId === "phone") {
    const digits = value.replace(/\D/g, "");

    if (digits.length > 9) {
      setFieldError(fieldId, "Use only 9 digits");
      return false;
    }

    if (showRequired && digits.length !== 9) {
      setFieldError(fieldId, "Enter 9 digits");
      return false;
    }
  }

  clearFieldError(fieldId);
  return true;
}

function setFieldError(fieldId, message) {
  const field = fieldMap[fieldId];

  if (!field) {
    return;
  }

  field.control.classList.add("has-error");
  field.error.textContent = message;
}

function clearFieldError(fieldId) {
  const field = fieldMap[fieldId];

  if (!field) {
    return;
  }

  field.control.classList.remove("has-error");
  field.error.textContent = "";
}

function clearAllFieldErrors() {
  for (const fieldId of requiredFieldIds) {
    clearFieldError(fieldId);
  }
}

function setStatus(message, className) {
  statusBox.textContent = message;
  statusBox.className = "form-status";

  if (className) {
    statusBox.classList.add(className);
  }
}
