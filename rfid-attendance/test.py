"""
RFID Attendance System - Local Terminal Version
No Google Sheets. No internet. Everything runs locally.

HOW TO RUN:
  1. Open terminal in this folder
  2. Run: python test.py
  3. Type a UID to simulate card scan
  4. See JSON output in terminal

Sample UIDs already registered:
  A1B2C3D4  -> John Smith (Engineering)
  E5F6G7H8  -> Sarah Johnson (Marketing)
  I9J0K1L2  -> Mike Wilson (HR)
"""

import json
import os
from datetime import datetime

# ---- LOCAL DATABASE (in memory) ----

employees = {
    "A1B2C3D4": {"id": "EMP001", "name": "John Smith", "department": "Engineering", "designation": "Software Engineer", "phone": "9876543210", "email": "john@company.com"},
    "E5F6G7H8": {"id": "EMP002", "name": "Sarah Johnson", "department": "Marketing", "designation": "Marketing Manager", "phone": "9876543211", "email": "sarah@company.com"},
    "I9J0K1L2": {"id": "EMP003", "name": "Mike Wilson", "department": "HR", "designation": "HR Executive", "phone": "9876543212", "email": "mike@company.com"},
}

attendance = []  # stores today's scans

# ---- CORE FUNCTIONS ----

def scan_card(uid):
    """Process a card scan and return JSON result"""
    uid = uid.strip().upper().replace(" ", "")
    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    time = now.strftime("%H:%M:%S")

    # Check if card is registered
    if uid not in employees:
        return {
            "status": "error",
            "message": "UNKNOWN CARD",
            "uid": uid,
            "timestamp": time
        }

    emp = employees[uid]

    # Find today's record for this employee
    today_record = None
    for rec in attendance:
        if rec["uid"] == uid and rec["date"] == date:
            today_record = rec
            break

    # 1st scan = CHECK IN
    if today_record is None:
        status = "Late" if is_late(time) else "Present"
        record = {
            "uid": uid,
            "employee_id": emp["id"],
            "employee_name": emp["name"],
            "department": emp["department"],
            "date": date,
            "check_in": time,
            "check_out": None,
            "working_hours": None,
            "status": status,
            "device": "Python_Terminal"
        }
        attendance.append(record)

        return {
            "status": "success",
            "type": "CHECK_IN",
            "employee": emp["name"],
            "employee_id": emp["id"],
            "department": emp["department"],
            "check_in": time,
            "attendance_status": status,
            "message": f"{emp['name']} checked in at {time}"
        }

    # 2nd scan = CHECK OUT
    if today_record["check_out"] is None:
        today_record["check_out"] = time
        today_record["working_hours"] = calc_hours(today_record["check_in"], time)

        return {
            "status": "success",
            "type": "CHECK_OUT",
            "employee": emp["name"],
            "employee_id": emp["id"],
            "department": emp["department"],
            "check_in": today_record["check_in"],
            "check_out": time,
            "working_hours": today_record["working_hours"],
            "message": f"{emp['name']} checked out at {time}"
        }

    # 3rd scan = IGNORE
    return {
        "status": "info",
        "type": "ALREADY_DONE",
        "employee": emp["name"],
        "employee_id": emp["id"],
        "check_in": today_record["check_in"],
        "check_out": today_record["check_out"],
        "working_hours": today_record["working_hours"],
        "message": f"{emp['name']} already done for today"
    }


def is_late(time_str):
    """Late if after 09:15"""
    parts = time_str.split(":")
    mins = int(parts[0]) * 60 + int(parts[1])
    return mins > 555  # 9*60+15


def calc_hours(check_in, check_out):
    """Calculate working hours between two times"""
    in_p = check_in.split(":")
    out_p = check_out.split(":")
    diff = (int(out_p[0]) * 60 + int(out_p[1])) - (int(in_p[0]) * 60 + int(in_p[1]))
    if diff < 0:
        diff += 1440
    return f"{diff // 60}h {diff % 60}m"


def show_employees():
    """Return all employees as JSON"""
    data = []
    for uid, emp in employees.items():
        data.append({"uid": uid, **emp})
    return {"status": "success", "count": len(data), "employees": data}


def show_attendance():
    """Return all attendance records as JSON"""
    return {"status": "success", "count": len(attendance), "records": attendance}


def add_employee():
    """Add a new employee"""
    print()
    uid = input("  RFID UID     : ").strip().upper().replace(" ", "")
    if not uid:
        return {"status": "error", "message": "UID cannot be empty"}
    if uid in employees:
        return {"status": "error", "message": "UID already registered", "existing": employees[uid]["name"]}

    emp_id = input("  Employee ID  : ").strip()
    name = input("  Name         : ").strip()
    dept = input("  Department   : ").strip()

    if not all([emp_id, name, dept]):
        return {"status": "error", "message": "All fields required"}

    employees[uid] = {
        "id": emp_id,
        "name": name,
        "department": dept,
        "designation": "",
        "phone": "",
        "email": ""
    }

    return {"status": "success", "message": f"{name} registered with UID {uid}"}


# ---- TERMINAL UI ----

def clear():
    os.system('cls' if os.name == 'nt' else 'clear')


def print_json(data):
    """Pretty print JSON with color-like formatting"""
    print()
    print("  " + "-" * 46)
    print("  JSON Response:")
    print("  " + "-" * 46)
    formatted = json.dumps(data, indent=4)
    for line in formatted.split("\n"):
        print("  " + line)
    print("  " + "-" * 46)


def main():
    clear()
    print()
    print("=" * 50)
    print("  RFID Attendance System - Terminal")
    print("=" * 50)
    print()
    print("  Ready! Type a UID to scan or a command.")
    print()
    print("  COMMANDS:")
    print("    scan <uid>   - Scan a card (or just type UID)")
    print("    employees    - Show all employees")
    print("    attendance   - Show all attendance records")
    print("    add          - Register new employee")
    print("    help         - Show this help")
    print("    quit         - Exit")
    print()
    print("  SAMPLE UIDs:")
    print("    A1B2C3D4  ->  John Smith")
    print("    E5F6G7H8  ->  Sarah Johnson")
    print("    I9J0K1L2  ->  Mike Wilson")
    print()

    while True:
        try:
            cmd = input("  SCAN > ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n  Bye!")
            break

        if not cmd:
            continue

        lower = cmd.lower()

        if lower in ("quit", "exit", "q"):
            print("  Bye!")
            break

        elif lower == "help":
            print()
            print("  scan <uid>   - Scan a card")
            print("  employees    - Show all employees")
            print("  attendance   - Show attendance records")
            print("  add          - Register new employee")
            print("  quit         - Exit")
            print()

        elif lower == "employees":
            print_json(show_employees())

        elif lower == "attendance":
            print_json(show_attendance())

        elif lower == "add":
            result = add_employee()
            print_json(result)

        else:
            # Treat as UID scan
            uid = cmd.replace("scan ", "").strip()
            result = scan_card(uid)
            print_json(result)


if __name__ == "__main__":
    main()
