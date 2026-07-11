"""
RFID UID Reader - ESP32 + RC522
Reads card UIDs from ESP32 serial and prints them.

pip install pyserial
python test.py
"""

import os


def import_pyserial():
    try:
        import serial
        import serial.tools.list_ports
    except ImportError:
        return None
    return serial


def find_port():
    serial = import_pyserial()
    if serial is None:
        print("  pyserial required. Install with: pip install pyserial")
        return None

    ports = serial.tools.list_ports.comports()
    if not ports:
        print("  No COM ports found.")
        return None
    print("\n  Available COM ports:")
    for i, p in enumerate(ports):
        print(f"    [{i}] {p.device} - {p.description}")
    print()
    choice = input("  Select port number: ").strip()
    try:
        return ports[int(choice)].device
    except (ValueError, IndexError):
        return None


def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    print()
    print("=" * 50)
    print("  RFID UID Reader")
    print("  Hardware: ESP32 + RC522")
    print("=" * 50)
    print()

    serial = import_pyserial()
    if serial is None:
        print("  pyserial required. Install with: pip install pyserial")
        return

    port = find_port()
    if not port:
        print("  No port selected. Exiting.")
        return

    print(f"\n  Connecting to {port}...")

    try:
        ser = serial.Serial(port, 115200, timeout=1)
    except serial.SerialException as e:
        print(f"  ERROR: {e}")
        return

    print("  Connected! Waiting for ESP32...")

    while True:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if line == "RFID_READY":
            print("  ESP32 is ready!")
            break
        if line:
            print(f"  ESP32: {line}")

    print()
    print("  *** SCAN A CARD ON THE READER ***")
    print("  (Press Ctrl+C to stop)\n")

    try:
        while True:
            line = ser.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            if line.startswith("UID:"):
                uid = line[4:]
                print(f"  UID: {uid}")
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        ser.close()


if __name__ == "__main__":
    main()
