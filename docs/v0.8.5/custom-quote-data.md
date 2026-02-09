# Storing custom data in quotes

In this version, we introduced the ability to attach arbitrary data to quotes. This allows Party A and Party B to persist off-chain commitments directly within a quote by calling the `sendQuoteWithAffiliateAndData` function. A good example of usage would be sending the `tempQuoteId` that solvers used in instant modes.

## Sending a Quote with Custom Data

**Example (front-end usage)**

```tsx
const data = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "string"],
  [123, "hello-world"]
);

const tx = await contract.sendQuoteWithAffiliateAndData(
  partyBsWhiteList,
  symbolId,
  positionType,
  orderType,
  price,
  quantity,
  cva,
  lf,
  partyAmm,
  partyBmm,
  deadline,
  affiliate,
  upnlSig,
  data
);
```

## SendQuote Event

When a quote is sent, two versions of the `SendQuote` event are emitted for backward compatibility:

### Deprecated Event (for backward compatibility)

```solidity
event SendQuote(
    address partyA,
    uint256 quoteId,
    address[] partyBsWhiteList,
    uint256 symbolId,
    PositionType positionType,
    OrderType orderType,
    uint256 price,
    uint256 marketPrice,
    uint256 quantity,
    uint256 cva,
    uint256 lf,
    uint256 partyAmm,
    uint256 partyBmm,
    uint256 tradingFee,
    uint256 deadline
);
```

### New Event (with affiliate and data)

```solidity
// Encoded paramsData: symbolId, positionType, orderType, price, marketPrice, quantity, cva, lf, partyAmm, partyBmm, tradingFee, deadline
event SendQuote(
    address partyA,
    uint256 quoteId,
    address[] partyBsWhiteList,
    address affiliate,
    bytes paramsData,
    bytes data
);
```

The new event includes:

- `affiliate`: The affiliate address associated with the quote
- `paramsData`: ABI-encoded quote parameters (to avoid stack-too-deep errors)
- `data`: Custom data attached to the quote

## Decoding the New SendQuote Event

Since `paramsData` uses standard `abi.encode`, you can decode it with any ABI decoder without manual byte slicing.

### Method 1: Using ethers.js AbiCoder (Recommended)

```tsx
import { ethers } from "ethers";

// Event signature for the new SendQuote event
const NEW_SEND_QUOTE_EVENT = "SendQuote(address,uint256,address[],address,bytes,bytes)";

// Decode paramsData from the new SendQuote event using standard ABI decoding
function decodeSendQuoteParamsData(paramsData: string) {
  // Since we use abi.encode, we can decode with standard ABI decoder
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
    paramsData
  );

  return {
    symbolId: decoded[0],
    positionType: decoded[1], // 0 = LONG, 1 = SHORT
    orderType: decoded[2], // 0 = LIMIT, 1 = MARKET
    price: decoded[3],
    marketPrice: decoded[4],
    quantity: decoded[5],
    cva: decoded[6],
    lf: decoded[7],
    partyAmm: decoded[8],
    partyBmm: decoded[9],
    tradingFee: decoded[10],
    deadline: decoded[11],
  };
}

// Decode custom data field
function decodeCustomData(data: string, types: string[]) {
  if (data === "0x" || data === "") {
    return null;
  }
  return ethers.AbiCoder.defaultAbiCoder().decode(types, data);
}

// Example: Listen to SendQuote events
async function listenToSendQuoteEvents(contract: ethers.Contract) {
  // Filter for the new event (6 indexed/non-indexed params)
  const filter = contract.filters["SendQuote(address,uint256,address[],address,bytes,bytes)"]();

  contract.on(filter, (partyA, quoteId, partyBsWhiteList, affiliate, paramsData, data, event) => {
    console.log("New SendQuote event received:");
    console.log("  partyA:", partyA);
    console.log("  quoteId:", quoteId.toString());
    console.log("  affiliate:", affiliate);

    // Decode the params using standard ABI decoder
    const params = decodeSendQuoteParamsData(paramsData);
    console.log("  symbolId:", params.symbolId.toString());
    console.log("  positionType:", params.positionType === 0 ? "LONG" : "SHORT");
    console.log("  orderType:", params.orderType === 0 ? "LIMIT" : "MARKET");
    console.log("  price:", ethers.formatUnits(params.price, 18));
    console.log("  quantity:", ethers.formatUnits(params.quantity, 18));

    // Decode custom data if present
    if (data && data !== "0x") {
      // Example: decode as [uint256, string]
      const customData = decodeCustomData(data, ["uint256", "string"]);
      console.log("  customData:", customData);
    }
  });
}

```

### Method 2: Manual Byte Slicing (without ethers.js)

If you're not using ethers.js or prefer manual decoding, you can slice the bytes directly. Since `abi.encode` pads each value to 32 bytes, the layout is predictable:

```tsx
// Manual decoding without ethers.js - works with raw bytes
function decodeSendQuoteParamsDataManual(paramsData: string): {
  symbolId: bigint;
  positionType: number;
  orderType: number;
  price: bigint;
  marketPrice: bigint;
  quantity: bigint;
  cva: bigint;
  lf: bigint;
  partyAmm: bigint;
  partyBmm: bigint;
  tradingFee: bigint;
  deadline: bigint;
} {
  // Remove 0x prefix if present
  const hex = paramsData.startsWith("0x") ? paramsData.slice(2) : paramsData;

  // With abi.encode, each value is padded to 32 bytes (64 hex chars)
  // Layout: symbolId(32) + positionType(32) + orderType(32) + price(32) + marketPrice(32) +
  //         quantity(32) + cva(32) + lf(32) + partyAmm(32) + partyBmm(32) + tradingFee(32) + deadline(32)

  let offset = 0;
  const sliceUint256 = (): bigint => {
    const value = BigInt("0x" + hex.slice(offset, offset + 64));
    offset += 64;
    return value;
  };

  return {
    symbolId: sliceUint256(),
    positionType: Number(sliceUint256()), // uint8 padded to 32 bytes
    orderType: Number(sliceUint256()),    // uint8 padded to 32 bytes
    price: sliceUint256(),
    marketPrice: sliceUint256(),
    quantity: sliceUint256(),
    cva: sliceUint256(),
    lf: sliceUint256(),
    partyAmm: sliceUint256(),
    partyBmm: sliceUint256(),
    tradingFee: sliceUint256(),
    deadline: sliceUint256(),
  };
}

// Example usage
const paramsData = "0x0000000000000000000000000000000000000000000000000000000000000001...";
const decoded = decodeSendQuoteParamsDataManual(paramsData);
console.log("symbolId:", decoded.symbolId.toString());
console.log("positionType:", decoded.positionType === 0 ? "LONG" : "SHORT");
```
