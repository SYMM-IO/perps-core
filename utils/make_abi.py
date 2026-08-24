#!/usr/bin/env python3
import json
import os
import re


def scandir(directory_name):
    sub_folders = [f.path for f in os.scandir(directory_name) if f.is_dir()]
    for directory in list(sub_folders):
        sub_folders.extend(scandir(directory))
    return sub_folders


def normalize_enum_type(type_str, internal_type_str):
    """
    Normalize enum types to uint8.
    Hardhat sometimes preserves qualified enum type names (e.g., ISymmio.PositionType)
    instead of resolving them to their underlying uint8 type.
    """
    if internal_type_str and internal_type_str.startswith("enum "):
        return "uint8"
    return type_str


def normalize_abi_types(item):
    """
    Recursively normalize all enum types in an ABI item to uint8.
    """
    if isinstance(item, dict):
        result = {}
        for key, value in item.items():
            if key == "type" and "internalType" in item:
                result[key] = normalize_enum_type(value, item.get("internalType", ""))
            elif key == "components" and isinstance(value, list):
                result[key] = [normalize_abi_types(comp) for comp in value]
            elif isinstance(value, list):
                result[key] = [normalize_abi_types(v) for v in value]
            elif isinstance(value, dict):
                result[key] = normalize_abi_types(value)
            else:
                result[key] = value
        return result
    elif isinstance(item, list):
        return [normalize_abi_types(i) for i in item]
    else:
        return item


def get_abi_signature(item):
    """
    Generate a unique signature for an ABI item based on type, name, and inputs.
    This helps in identifying duplicate functions or events.
    """
    signature = item.get("type", "")
    if "name" in item:
        signature += item["name"]
    if "inputs" in item:
        inputs = item["inputs"]
        input_types = [inp.get("type", "") for inp in inputs]
        signature += "(" + ",".join(input_types) + ")"
    return signature


def remove_duplicates(abi_list):
    unique_abi = []
    seen = set()
    for item in abi_list:
        signature = get_abi_signature(item)
        if signature not in seen:
            seen.add(signature)
            unique_abi.append(item)
    return unique_abi


def generate_diamond_abi(subdirs, output_name):
    """
    Generate combined ABI for diamond pattern contracts by merging ABIs
    from multiple subdirectories.
    """
    abi_data = []
    for subdir in subdirs:
        directory_path = os.path.join("artifacts", "contracts", subdir)
        if not os.path.exists(directory_path):
            print(f"Directory {directory_path} does not exist. Skipping.")
            continue

        # Get all subdirectories under the current subdir
        facets_dirs = [directory_path] + scandir(directory_path)
        for address in facets_dirs:
            print(f"Checking {address}")
            files = [
                os.path.join(address, f)
                for f in os.listdir(address)
                if re.fullmatch(r".*\.json", f)
                and not re.fullmatch(r".*\.dbg\.json", f)
            ]
            if len(files) == 0:
                continue
            for file in files:
                with open(file) as f:
                    data = json.load(f)
                    if "abi" in data:
                        # Normalize enum types to uint8
                        normalized_abi = [normalize_abi_types(item) for item in data["abi"]]
                        abi_data += normalized_abi

    # Remove duplicates
    unique_abi_data = remove_duplicates(abi_data)

    with open(f"abis/{output_name}.json", "w") as f:
        json.dump(unique_abi_data, f, indent=4)
    print(f"Generated abis/{output_name}.json")


def generate_single_contract_abi(contract_path, contract_name, output_name):
    """
    Generate ABI for a single contract from its artifact file.
    """
    artifact_path = os.path.join(
        "artifacts", "contracts", contract_path, f"{contract_name}.json"
    )
    if not os.path.exists(artifact_path):
        print(f"Artifact {artifact_path} does not exist. Skipping {contract_name}.")
        return

    with open(artifact_path) as f:
        data = json.load(f)
        if "abi" in data:
            # Normalize enum types to uint8
            normalized_abi = [normalize_abi_types(item) for item in data["abi"]]
            with open(f"abis/{output_name}.json", "w") as out_f:
                json.dump(normalized_abi, out_f, indent=4)
            print(f"Generated abis/{output_name}.json")
        else:
            print(f"No ABI found in {artifact_path}")


def main():
    os.makedirs("abis", exist_ok=True)  # Ensure the output directory exists

    # Generate Symmio diamond ABI (combines facets, libraries, utils, interfaces, storages)
    print("\n=== Generating Symmio ABI ===")
    generate_diamond_abi(
        [
            "core/facets",
            "core/libraries",
            "core/utils",
            "core/storages",
        ],
        "symmio",
    )

    # Generate AccountLayer diamond ABI (combines accountLayer facets, libraries, utils, interfaces, storages)
    print("\n=== Generating AccountLayer ABI ===")
    generate_diamond_abi(
        [
            "accountLayer/facets",
            "accountLayer/libraries",
            "accountLayer/utils",
            "accountLayer/storages",
        ],
        "accountLayer",
    )

    # Generate ABIs for standalone contracts
    standalone_contracts = [
        ("helpers/accounts/SymmioPartyB.sol", "SymmioPartyB", "partyB"),
        ("instantLayer/InstantLayer.sol", "InstantLayer", "instantLayer"),
        ("accountLayer/AccountManager.sol", "AccountManager", "accountManager"),
        ("helpers/accounts/MultiAccount.sol", "MultiAccount", "multiAccount"),
        ("gaslessLayer/GaslessLayer.sol", "GaslessLayer", "gaslessLayer"),
        ("gaslessLayer/GaslessWallet.sol", "GaslessWallet", "gaslessLayerWallet"),
    ]

    for contract_path, contract_name, output_name in standalone_contracts:
        print(f"\n=== Generating {contract_name} ABI ===")
        generate_single_contract_abi(contract_path, contract_name, output_name)


if __name__ == "__main__":
    main()
