import { ethers } from "ethers";
import axios from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export async function getWalletBalanceInUsd() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const cleanAddress = ethers.getAddress(config.walletAddress.trim());
  const [balanceWei, priceResponse] = await Promise.all([
    provider.getBalance(cleanAddress),
    axios.get("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDC"),
  ]);

  const balanceEth = parseFloat(ethers.formatEther(balanceWei));
  const ethPrice = parseFloat(priceResponse.data.price);
  const balanceUsd = balanceEth * ethPrice;

  logger.info(
    `Wallet ${config.walletAddress}: ${balanceEth.toFixed(6)} ETH × $${ethPrice.toFixed(2)} = $${balanceUsd.toFixed(2)}`,
  );

  return balanceUsd;
}
