// SPDX-License-Identifier: MIT
pragma solidity 0.8.4;

interface MockIBtcLightClient {
    function checkTxProof(bytes32 txid, uint32 blockHeight, uint32 confirmBlock, bytes32[] calldata nodes, uint256 index) external view returns (bool);

    function getChainTipHeight() external view returns (uint);
}