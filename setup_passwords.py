from getpass import getpass
from werkzeug.security import generate_password_hash

print("Create password hashes for the local tracker.")
print("Copy the resulting values into the environment variables noted below.\n")

for role in ("user", "admin"):
    password = getpass(f"{role} password: ")
    confirm = getpass("Confirm password: ")
    if password != confirm:
        raise SystemExit(f"{role}: passwords did not match.")
    print(f"\n{role.upper()}_PASSWORD_HASH={generate_password_hash(password)}\n")
