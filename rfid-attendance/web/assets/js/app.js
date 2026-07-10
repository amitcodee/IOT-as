/**
 * ============================================================
 * RFID Employee Attendance System - Main Application JavaScript
 * ============================================================
 *
 * This file contains all the core functionality for the web dashboard.
 * It handles API communication, data management, and UI updates.
 *
 * CONFIGURATION:
 * Replace the SCRIPT_URL below with your Google Apps Script deployment URL.
 * ============================================================
 */

// ============================================================
// CONFIGURATION - CHANGE THIS URL
// ============================================================

const CONFIG = {
  // Replace with your Google Apps Script Web App URL
  SCRIPT_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",

  // Auto-refresh interval (milliseconds)
  REFRESH_INTERVAL: 5000,

  // Items per page for tables
  ITEMS_PER_PAGE: 10,

  // Company name
  COMPANY_NAME: "TechCorp Solutions"
};

// ============================================================
// API SERVICE - Handles all communication with Google Apps Script
// ============================================================

const API = {
  /**
   * Send GET request to Google Apps Script
   */
  async get(action, params = {}) {
    try {
      const url = new URL(CONFIG.SCRIPT_URL);
      url.searchParams.append("action", action);
      Object.keys(params).forEach(key => {
        if (params[key]) url.searchParams.append(key, params[key]);
      });

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error("Network response was not ok");
      return await response.json();
    } catch (error) {
      console.error(`API GET Error (${action}):`, error);
      throw error;
    }
  },

  /**
   * Send POST request to Google Apps Script
   */
  async post(data) {
    try {
      const response = await fetch(CONFIG.SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error("Network response was not ok");
      return await response.json();
    } catch (error) {
      console.error("API POST Error:", error);
      throw error;
    }
  },

  // Specific API methods
  async getDashboardStats() {
    return this.get("getDashboardStats");
  },

  async getEmployees() {
    return this.get("getEmployees");
  },

  async getEmployee(id) {
    return this.get("getEmployee", { id });
  },

  async getAttendance(params = {}) {
    return this.get("getAttendance", params);
  },

  async addEmployee(data) {
    return this.post({ action: "addEmployee", ...data });
  },

  async updateEmployee(data) {
    return this.post({ action: "updateEmployee", ...data });
  },

  async deleteEmployee(employeeId) {
    return this.post({ action: "deleteEmployee", employeeId });
  },

  async registerRFID(data) {
    return this.post({ action: "registerRFID", ...data });
  },

  async login(email, password) {
    return this.post({ action: "login", email, password });
  },

  async getLastUID() {
    return this.get("getLastUID");
  }
};

// ============================================================
// AUTHENTICATION SERVICE
// ============================================================

const Auth = {
  isLoggedIn() {
    return sessionStorage.getItem("isLoggedIn") === "true";
  },

  getUser() {
    const user = sessionStorage.getItem("user");
    return user ? JSON.parse(user) : null;
  },

  login(user) {
    sessionStorage.setItem("isLoggedIn", "true");
    sessionStorage.setItem("user", JSON.stringify(user));
  },

  logout() {
    sessionStorage.removeItem("isLoggedIn");
    sessionStorage.removeItem("user");
    window.location.href = "login.html";
  },

  checkAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = "login.html";
      return false;
    }
    return true;
  }
};

// ============================================================
// THEME MANAGER
// ============================================================

const Theme = {
  init() {
    const savedTheme = localStorage.getItem("theme") || "light";
    this.set(savedTheme);
  },

  toggle() {
    const current = document.documentElement.getAttribute("data-theme");
    const newTheme = current === "dark" ? "light" : "dark";
    this.set(newTheme);
  },

  set(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      btn.innerHTML = theme === "dark"
        ? '<i class="fas fa-sun"></i>'
        : '<i class="fas fa-moon"></i>';
    }
  }
};

// ============================================================
// TOAST NOTIFICATION SYSTEM
// ============================================================

const Toast = {
  container: null,

  init() {
    if (!document.querySelector(".toast-container")) {
      this.container = document.createElement("div");
      this.container.className = "toast-container";
      document.body.appendChild(this.container);
    } else {
      this.container = document.querySelector(".toast-container");
    }
  },

  show(message, type = "info", duration = 3000) {
    if (!this.container) this.init();

    const icons = {
      success: "fas fa-check-circle",
      error: "fas fa-times-circle",
      warning: "fas fa-exclamation-circle",
      info: "fas fa-info-circle"
    };

    const toast = document.createElement("div");
    toast.className = `toast-message toast-${type}`;
    toast.innerHTML = `<i class="${icons[type]}"></i><span>${message}</span>`;
    this.container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, "success"); },
  error(msg) { this.show(msg, "error"); },
  warning(msg) { this.show(msg, "warning"); },
  info(msg) { this.show(msg, "info"); }
};

// ============================================================
// LOADING STATE MANAGER
// ============================================================

const Loading = {
  show() {
    const overlay = document.querySelector(".loading-overlay");
    if (overlay) overlay.classList.add("active");
  },

  hide() {
    const overlay = document.querySelector(".loading-overlay");
    if (overlay) overlay.classList.remove("active");
  }
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

const Utils = {
  /**
   * Format date to readable string
   */
  formatDate(dateStr) {
    if (!dateStr) return "N/A";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  },

  /**
   * Format time to 12-hour format
   */
  formatTime(timeStr) {
    if (!timeStr) return "---";
    const parts = timeStr.split(":");
    let hours = parseInt(parts[0]);
    const minutes = parts[1];
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  },

  /**
   * Get today's date in YYYY-MM-DD format
   */
  getToday() {
    return new Date().toISOString().split("T")[0];
  },

  /**
   * Animate counter from 0 to target value
   */
  animateCounter(element, target) {
    let current = 0;
    const duration = 1000;
    const step = target / (duration / 16);

    const timer = setInterval(() => {
      current += step;
      if (current >= target) {
        current = target;
        clearInterval(timer);
      }
      element.textContent = Math.floor(current);
    }, 16);
  },

  /**
   * Generate random color for avatars
   */
  getAvatarColor(name) {
    const colors = [
      "#667eea", "#764ba2", "#f093fb", "#f5576c",
      "#4facfe", "#43e97b", "#fa709a", "#a18cd1"
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  },

  /**
   * Get initials from name
   */
  getInitials(name) {
    return name.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2);
  },

  /**
   * Debounce function
   */
  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },

  /**
   * Export table data to CSV
   */
  exportCSV(data, filename) {
    if (!data || data.length === 0) {
      Toast.warning("No data to export");
      return;
    }

    const headers = Object.keys(data[0]);
    const csv = [
      headers.join(","),
      ...data.map(row => headers.map(h => `"${row[h] || ""}"`).join(","))
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}_${Utils.getToday()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    Toast.success("CSV exported successfully");
  },

  /**
   * Print table content
   */
  printTable(tableId, title) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const printWindow = window.open("", "", "width=900,height=600");
    printWindow.document.write(`
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h2 { text-align: center; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
          th { background: #4285f4; color: white; }
          tr:nth-child(even) { background: #f9f9f9; }
          .print-date { text-align: right; font-size: 11px; color: #666; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="print-date">Printed: ${new Date().toLocaleString()}</div>
        <h2>${title}</h2>
        ${table.outerHTML}
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  }
};

// ============================================================
// SIDEBAR NAVIGATION
// ============================================================

const Sidebar = {
  init() {
    const menuToggle = document.querySelector(".menu-toggle");
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.querySelector(".sidebar-overlay");

    if (menuToggle) {
      menuToggle.addEventListener("click", () => {
        sidebar.classList.toggle("active");
        overlay.classList.toggle("active");
      });
    }

    if (overlay) {
      overlay.addEventListener("click", () => {
        sidebar.classList.remove("active");
        overlay.classList.remove("active");
      });
    }

    // Highlight active nav item
    const currentPage = window.location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".sidebar-nav a").forEach(link => {
      const href = link.getAttribute("href");
      if (href === currentPage) {
        link.classList.add("active");
      }
    });
  }
};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  Theme.init();
  Toast.init();
  Sidebar.init();

  // Theme toggle button
  const themeBtn = document.querySelector(".theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => Theme.toggle());
  }

  // Logout button
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      Auth.logout();
    });
  }
});
