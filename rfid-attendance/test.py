"""
RFID Attendance System - Terminal Test Script
Run: python test.py
"""

import requests
import json
import time
import os

# CHANGE THIS to your Google Apps Script URL
API_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"

def clear():
    os.system('cls' if os.name == 'nt' else 'clear')

def test_api():
    """Check if API is working"""
    print("Testing API connection...")
    try:
        r = requests.get(API_URL, params={"action": "test"})
        data = r.json()
        print(json.dumps(data, indent=2))
        return data.get("status") == "success"
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def get_employees():
    """Get all employees"""
    r = requests.get(API_URL, params={"action": "getEmployees"})
    data = r.json()
    print(json.dumps(data, indent=2))
    return data

def get_attendance():
    """Get all attendance records"""
    r = requests.get(API_URL, params={"action": "getAttendance"})
    data = r.json()
    print(json.dumps(data, indent=2))
    return data

def scan_card(uid):
    """Simulate RFID card scan"""
    payload = {
        "action": "scan",
        "rfid_uid": uid,
        "device": "Python_Terminal",
        "ip": "127.0.0.1"
    }
    r = requests.post(API_URL, data=json.dumps(payload))
    data = r.json()
    print(json.dumps(data, indent=2))
    return data

def menu():
    clear()
    print("=" * 50)
    print("  RFID Attendance System - Terminal Test")
    print("=" * 50)
    print()
    print("  1. Test API Connection")
    print("  2. Show All Employees")
    print("  3. Show All Attendance")
    print("  4. Scan RFID Card (simulate)")
    print("  5. Exit")
    print()
    return input("  Choose (1-5): ").strip()

def main():
    if "YOUR_DEPLOYMENT_ID" in API_URL:
        print("ERROR: Edit test.py and set your API_URL first!")
        print("Replace YOUR_DEPLOYMENT_ID with your Google Apps Script URL")
        return

    while True:
        choice = menu()

        if choice == "1":
            print()
            test_api()

        elif choice == "2":
            print()
            get_employees()

        elif choice == "3":
            print()
            get_attendance()

        elif choice == "4":
            print()
            print("Sample UIDs: A1 B2 C3 D4 | E5 F6 G7 H8 | I9 J0 K1 L2")
            uid = input("Enter RFID UID: ").strip()
            if uid:
                print()
                scan_card(uid)

        elif choice == "5":
            print("Bye!")
            break

        else:
            print("Invalid choice")

        print()
        input("Press Enter to continue...")

if __name__ == "__main__":
    main()
