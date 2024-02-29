// SPDX-License-Identifier: MIT
pragma solidity 0.8.4;

import "./interfaces/ICcTransferRouterStorage.sol";

contract CcTransferRouterStorage is ICcTransferRouterStorage {

    // Constants
    uint constant MAX_PROTOCOL_FEE = 10000;

    // Public variables
    uint public override startingBlockNumber;
    uint public override version;
    uint public override chainId;
    uint public override appId;
    uint public override protocolPercentageFee; // A number between 0 to 10000
    address public override relay;
    address public override lockers;
    address public override coreBTC;
    address public override treasury;
    mapping(bytes32 => ccTransferRequest) public ccTransferRequests; // TxId to ccTransferRequest structure

}