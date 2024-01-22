// SPDX-License-Identifier: MIT
pragma solidity 0.8.4;

import "./interfaces/IBurnRouter.sol";
import "../erc20/interfaces/ICoreBTC.sol";
import "../lockers/interfaces/ILockers.sol";
import "../libraries/BurnRouterLib.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";


contract BurnRouterLogic is IBurnRouter, BurnRouterStorage,
    Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {

    using BitcoinHelper for bytes;

    modifier nonZeroAddress(address _address) {
        require(_address != address(0), "BurnRouter: zero address");
        _;
    }

    modifier onlyOracle(address _bitcoinFeeOracle) {
        require(_bitcoinFeeOracle == bitcoinFeeOracle, "BurnRouter: not oracle");
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Handles cross-chain burn requests
    /// @param _startingBlockNumber Requests that are included in a block older
    ///                             than _startingBlockNumber cannot be executed
    /// @param _relay Address of relay contract
    /// @param _lockers Address of lockers contract
    /// @param _treasury Address of the treasury of the protocol
    /// @param _coreBTC Address of coreBTC contract
    /// @param _transferDeadline of sending BTC to user (aster submitting a burn request)
    /// @param _protocolPercentageFee Percentage of tokens that user pays to protocol for burning
    /// @param _slasherPercentageReward Percentage of tokens that slasher receives after slashing a locker
    /// @param _bitcoinFee Fee of submitting a transaction on Bitcoin
    function initialize(
        uint _startingBlockNumber,
        address _relay,
        address _lockers,
        address _treasury,
        address _coreBTC,
        uint _transferDeadline,
        uint _protocolPercentageFee,
        uint _slasherPercentageReward,
        uint _bitcoinFee
    ) public initializer {
        Ownable2StepUpgradeable.__Ownable2Step_init();
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        UUPSUpgradeable.__UUPSUpgradeable_init();

        _setStartingBlockNumber(_startingBlockNumber);
        _setRelay(_relay);
        _setLockers(_lockers);
        _setTreasury(_treasury);
        _setCoreBTC(_coreBTC);
        _setTransferDeadline(_transferDeadline);
        _setProtocolPercentageFee(_protocolPercentageFee);
        _setSlasherPercentageReward(_slasherPercentageReward);
        _setBitcoinFee(_bitcoinFee);
        _setBitcoinFeeOracle(owner());
    }

    receive() external payable {}

    function renounceOwnership() public virtual override onlyOwner {}

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @notice Returns true is request has been processed
    /// @param _lockerTargetAddress Locker address on the target chain
    /// @param _index the request for the locker
    function isTransferred(
        address _lockerTargetAddress,
        uint _index
    ) external view override returns (bool) {
        return burnRequests[_lockerTargetAddress][_index].isTransferred;
    }

    /// @notice Setter for starting block number
    function setStartingBlockNumber(uint _startingBlockNumber) external override onlyOwner {
        _setStartingBlockNumber(_startingBlockNumber);
    }

    /// @notice Updates relay contract address
    /// @dev Only owner can call this
    /// @param _relay The new relay contract address
    function setRelay(address _relay) external override onlyOwner {
        _setRelay(_relay);
    }

    /// @notice Updates lockers contract address
    /// @dev Only owner can call this
    /// @param _lockers The new lockers contract address
    function setLockers(address _lockers) external override onlyOwner {
        _setLockers(_lockers);
    }

    /// @notice Updates coreBTC contract address
    /// @dev Only owner can call this
    /// @param _coreBTC The new coreBTC contract address
    function setCoreBTC(address _coreBTC) external override onlyOwner {
        _setCoreBTC(_coreBTC);
    }

    /// @notice Updates protocol treasury address
    /// @dev Only owner can call this
    /// @param _treasury The new treasury address
    function setTreasury(address _treasury) external override onlyOwner {
        _setTreasury(_treasury);
    }

    /// @notice Updates deadline of executing burn requests
    /// @dev Only owner can call this
    ///      Deadline should be greater than relay finalization parameter
    /// @param _transferDeadline The new transfer deadline
    function setTransferDeadline(uint _transferDeadline) external override {
        _setTransferDeadline(_transferDeadline);
    }

    /// @notice Updates protocol percentage fee for burning tokens
    /// @dev Only owner can call this
    /// @param _protocolPercentageFee The new protocol percentage fee
    function setProtocolPercentageFee(uint _protocolPercentageFee) external override onlyOwner {
        _setProtocolPercentageFee(_protocolPercentageFee);
    }

    /// @notice Updates slasher percentage reward for disputing lockers
    /// @dev Only owner can call this
    /// @param _slasherPercentageReward The new slasher percentage reward
    function setSlasherPercentageReward(uint _slasherPercentageReward) external override onlyOwner {
        _setSlasherPercentageReward(_slasherPercentageReward);
    }

    /// @notice Updates Bitcoin oracle
    /// @dev Only owner can call this
    /// @param _bitcoinFeeOracle Address of oracle who can update burn fee
    function setBitcoinFeeOracle(address _bitcoinFeeOracle) external override onlyOwner {
        _setBitcoinFeeOracle(_bitcoinFeeOracle);
    }

    /// @notice Updates Bitcoin transaction fee
    /// @dev Only owner can call this
    /// @param _bitcoinFee The new Bitcoin transaction fee
    function setBitcoinFee(uint _bitcoinFee) external override onlyOracle(msg.sender) {
        _setBitcoinFee(_bitcoinFee);
    }

    /// @notice Records users burn request
    /// @dev After submitting the burn request, Locker has a limited time
    ///      to send BTC and provide burn proof
    /// @param _amount of coreBTC that user wants to burn
    /// @param _userScript User script hash
    /// @param _scriptType User script type
    /// @param _lockerLockingScript	of locker that should execute the burn request
    /// @return Amount of BTC that user receives
    function ccBurn(
        uint _amount,
        bytes memory _userScript,
        ScriptTypes _scriptType,
        bytes calldata _lockerLockingScript
    ) external nonReentrant override returns (uint) {
        // Transfers user's coreBTC to contract
        require(
            ICoreBTC(coreBTC).transferFrom(_msgSender(), address(this), _amount),
            "BurnRouter: transferFrom failed"
        );

        (uint burntAmount, address lockerTargetAddress) = _ccBurn(
            _amount,
            _userScript,
            _scriptType,
            _lockerLockingScript
        );

        emit CCBurn(
            _msgSender(),
            _userScript,
            _scriptType,
            _amount,
            burntAmount,
            lockerTargetAddress,
            burnRequests[lockerTargetAddress][burnRequests[lockerTargetAddress].length - 1].requestIdOfLocker, // index of request
            burnRequests[lockerTargetAddress][burnRequests[lockerTargetAddress].length - 1].deadline
        );

        return burntAmount;

    }

    /// @notice Checks the correctness of burn proof (which is a Bitcoin tx)
    /// @dev Makes isTransferred flag true for the paid requests
    /// @param _tx Bitcoin tx data
    /// @param _blockNumber Height of the block containing the Bitcoin tx
    /// @param _intermediateNodes Merkle inclusion proof for the Bitcoin tx
    /// @param _index Index of the Bitcoin tx the block
    /// @param _lockerLockingScript Locker's locking script that this burn request belongs to
    /// @param _burnReqIndexes Indexes of requests that locker wants to provide proof for them
    /// @param _voutIndexes Indexes of outputs that were used to pay burn requests.
    ///                     _voutIndexes[i] belongs to _burnReqIndexes[i]
    function burnProof(
        bytes calldata _tx,
        uint256 _blockNumber,
        bytes memory _intermediateNodes,
        uint _index,
        bytes memory _lockerLockingScript,
        uint[] memory _burnReqIndexes,
        uint[] memory _voutIndexes
    ) external nonReentrant override returns (bool) {
        require(_blockNumber >= startingBlockNumber, "BurnRouter: old request");

        (, , bytes29 voutView, uint32 lockTime) = _tx.extractTx();

        // Checks that locker's tx doesn't have any locktime
        require(lockTime == 0, "BurnRouter: non-zero lock time");

        // Checks if the locking script is valid
        require(
            ILockers(lockers).isLocker(_lockerLockingScript),
            "BurnRouter: not locker"
        );

        require(
            _burnReqIndexes.length == _voutIndexes.length,
            "BurnRouter: wrong indexes"
        );

        // Checks inclusion of transaction
        bytes32 txId = BitcoinHelper.calculateTxId(_tx);
        require(
            BurnRouterLib.isConfirmed(
                relay,
                txId,
                _blockNumber,
                _intermediateNodes,
                _index
            ),
            "BurnRouter: not finalized"
        );

        // Get the target address of the locker from its locking script
        address _lockerTargetAddress = ILockers(lockers).getLockerTargetAddress(_lockerLockingScript);

        // Checks the paid burn requests
        uint paidOutputCounter = _checkPaidBurnRequests(
            txId,
            _blockNumber,
            _lockerTargetAddress,
            voutView,
            _burnReqIndexes,
            _voutIndexes
        );

        /*
            Checks if there is an output that goes back to the locker
            Sets isUsedAsBurnProof of txId true if all the outputs (except one) were used to pay cc burn requests
        */
        BurnRouterLib.updateIsUsedAsBurnProof(
            isUsedAsBurnProof,
            paidOutputCounter,
            voutView,
            _lockerLockingScript,
            txId
        );

        return true;
    }

    /// @notice Slashes a locker if did not pay a cc burn request before its deadline
    /// @param _lockerLockingScript Locker's locking script that the unpaid request belongs to
    /// @param _indices Indices of requests that their deadline has passed
    function disputeBurn(
        bytes calldata _lockerLockingScript,
        uint[] memory _indices
    ) external nonReentrant onlyOwner override {
        // Checks if the locking script is valid
        require(
            ILockers(lockers).isLocker(_lockerLockingScript),
            "BurnRouter: not locker"
        );

        // Get the target address of the locker from its locking script
        address _lockerTargetAddress = ILockers(lockers).getLockerTargetAddress(_lockerLockingScript);

        // Goes through provided indexes of burn requests to see if locker should be slashed
        for (uint i = 0; i < _indices.length; i++) {

            BurnRouterLib.disputeBurnHelper(
                burnRequests,
                _lockerTargetAddress,
                _indices[i],
                transferDeadline,
                BurnRouterLib.lastSubmittedHeight(relay),
                startingBlockNumber
            );

            // Slashes locker and sends the slashed amount to the user
            ILockers(lockers).slashIdleLocker(
                _lockerTargetAddress,
                burnRequests[_lockerTargetAddress][_indices[i]].amount*slasherPercentageReward/MAX_SLASHER_REWARD, // Slasher reward
                _msgSender(), // Slasher address
                burnRequests[_lockerTargetAddress][_indices[i]].amount,
                burnRequests[_lockerTargetAddress][_indices[i]].sender // User address
            );

            emit BurnDispute(
                burnRequests[_lockerTargetAddress][_indices[i]].sender,
                _lockerTargetAddress,
                _lockerLockingScript,
                burnRequests[_lockerTargetAddress][_indices[i]].requestIdOfLocker
            );
        }
    }

    /// @notice Slashes a locker if they issue a tx that doesn't match any burn request
    /// @dev Input tx is a malicious tx which shows that locker spent BTC
    ///      Output tx is the tx that was spent by locker in input tx
    ///      Output tx shows money goes to locker
    ///      Input tx shows locker steals the funds
    /// @param _lockerLockingScript Suspicious locker's locking script
    /// @param _inputTx Malicious transaction
    /// @param _outputTx Spent transaction
    /// @param _inputIntermediateNodes Merkle inclusion proof for the malicious transaction
    /// @param _indexesAndBlockNumbers Indices of malicious input in input tx,
    ///                                input tx in block and block number of input tx
    function disputeLocker(
        bytes memory _lockerLockingScript,
        bytes calldata _inputTx,
        bytes calldata _outputTx,
        bytes memory _inputIntermediateNodes,
        uint[] memory _indexesAndBlockNumbers // [inputIndex, inputTxIndex, inputTxBlockNumber]
    ) external nonReentrant onlyOwner override {

        // Checks if the locking script is valid
        require(
            ILockers(lockers).isLocker(_lockerLockingScript),
            "BurnRouter: not locker"
        );

        // Finds input tx id and checks its inclusion
        bytes32 _inputTxId = BitcoinHelper.calculateTxId(_inputTx);

        BurnRouterLib.disputeLockerHelper(
            isUsedAsBurnProof,
            transferDeadline,
            relay,
            startingBlockNumber,
            _inputTxId,
            _inputIntermediateNodes,
            _indexesAndBlockNumbers
        );

        (, bytes29 vinView, bytes29 voutView, ) = _inputTx.extractTx();

        // Extracts outpoint id and index from input tx
        (bytes32 _outpointId, uint _outpointIndex) = BitcoinHelper.extractOutpoint(
            vinView,
            _indexesAndBlockNumbers[0] // Index of malicious input in input tx
        );

        // Checks that "outpoint tx id == output tx id"
        require(
            _outpointId == BitcoinHelper.calculateTxId(_outputTx),
            "BurnRouter: wrong output tx"
        );


        // Checks that _outpointIndex of _outpointId belongs to locker locking script
        (, , bytes29 outputTxVoutView, ) = _outputTx.extractTx();
        require(
            keccak256(BitcoinHelper.getLockingScript(outputTxVoutView, _outpointIndex)) ==
            keccak256(_lockerLockingScript),
            "BurnRouter: not for locker"
        );

        // Slashes locker
        _slashLockerForDispute(
            voutView,
            _lockerLockingScript,
            _inputTxId,
            _indexesAndBlockNumbers[2] // Block number
        );
    }

    /// @notice Burns coreBTC and records the burn request
    /// @return _burntAmount Amount of BTC that user receives
    /// @return _lockerTargetAddress Address of locker that will execute the request
    function _ccBurn(
        uint _amount,
        bytes memory _userScript,
        ScriptTypes _scriptType,
        bytes calldata _lockerLockingScript
    ) private returns (uint _burntAmount, address _lockerTargetAddress) {
        // Checks validity of user script
        _checkScriptType(_userScript, _scriptType);

        // Checks if the given locking script is locker
        require(
            ILockers(lockers).isLocker(_lockerLockingScript),
            "BurnRouter: not locker"
        );

        // Gets the target address of locker
        _lockerTargetAddress = ILockers(lockers).getLockerTargetAddress(_lockerLockingScript);

        uint remainingAmount = _getFees(_amount);

        // Burns remained coreBTC
        ICoreBTC(coreBTC).approve(lockers, remainingAmount);

        // Reduces the Bitcoin fee to find the amount that user receives (called burntAmount)
        _burntAmount = (ILockers(lockers).burn(_lockerLockingScript, remainingAmount))
            * (remainingAmount - bitcoinFee) / remainingAmount;

        _saveBurnRequest(
            _amount,
            _burntAmount,
            _userScript,
            _scriptType,
            BurnRouterLib.lastSubmittedHeight(relay),
            _lockerTargetAddress
        );
    }

    /// @notice Slashes the malicious locker
    /// @param _inputVoutView Outputs view of the malicious transaction
    /// @param _lockerLockingScript Malicious locker's locking script
    /// @param _inputTxId Tx id of the malicious transaction
    /// @param _inputBlockNumber Block number of the malicious transaction
    function _slashLockerForDispute(
        bytes29 _inputVoutView,
        bytes memory _lockerLockingScript,
        bytes32 _inputTxId,
        uint _inputBlockNumber
    ) private {

        // Finds total value of malicious transaction
        uint totalValue = BitcoinHelper.parseOutputsTotalValue(_inputVoutView);

        // Gets the target address of the locker from its Bitcoin address
        address _lockerTargetAddress = ILockers(lockers).getLockerTargetAddress(_lockerLockingScript);

        ILockers(lockers).slashThiefLocker(
            _lockerTargetAddress,
            totalValue*slasherPercentageReward/MAX_SLASHER_REWARD, // Slasher reward
            _msgSender(), // Slasher address
            totalValue
        );

        // Emits the event
        emit LockerDispute(
            _lockerTargetAddress,
            _lockerLockingScript,
            _inputBlockNumber,
            _inputTxId,
            totalValue + totalValue*slasherPercentageReward/MAX_SLASHER_REWARD
        );
    }

    /// @notice Checks the burn requests that get paid by this transaction
    /// @param _paidBlockNumber Block number in which locker paid the burn request
    /// @param _lockerTargetAddress Address of the locker on the target chain
    /// @param _voutView Outputs view of a transaction
    /// @param _burnReqIndexes Indexes of requests that locker provides proof for them
    /// @param _voutIndexes Indexes of outputs that were used to pay burn requests
    /// @return paidOutputCounter Number of executed burn requests
    function _checkPaidBurnRequests(
        bytes32 txId,
        uint _paidBlockNumber,
        address _lockerTargetAddress,
        bytes29 _voutView,
        uint[] memory _burnReqIndexes,
        uint[] memory _voutIndexes
    ) private returns (uint paidOutputCounter) {
        uint parsedAmount;
        /*
            Below variable is for checking that every output in vout (except one)
            is related to a cc burn request so that we can
            set "isUsedAsBurnProof = true" for the whole txId
        */
        paidOutputCounter = 0;

        uint tempVoutIndex;

        for (uint i = 0; i < _burnReqIndexes.length; i++) {

            // prevent from sending repeated vout indexes
            if (i == 0) {
                tempVoutIndex = _voutIndexes[i];
            } else {
                require(
                    _voutIndexes[i] > tempVoutIndex,
                    "BurnRouter: un-sorted vout indexes"
                );

                tempVoutIndex = _voutIndexes[i];
            }

            uint _burnReqIndex = _burnReqIndexes[i];
            // Checks that the request has not been paid and its deadline has not passed
            if (
                !burnRequests[_lockerTargetAddress][_burnReqIndex].isTransferred &&
                burnRequests[_lockerTargetAddress][_burnReqIndex].deadline >= _paidBlockNumber
            ) {

                parsedAmount = BitcoinHelper.parseValueFromSpecificOutputHavingScript(
                    _voutView,
                    _voutIndexes[i],
                    burnRequests[_lockerTargetAddress][_burnReqIndex].userScript,
                    burnRequests[_lockerTargetAddress][_burnReqIndex].scriptType
                );

                // Checks that locker has sent required coreBTC amount
                if (burnRequests[_lockerTargetAddress][_burnReqIndex].burntAmount == parsedAmount) {
                    burnRequests[_lockerTargetAddress][_burnReqIndex].isTransferred = true;
                    paidOutputCounter = paidOutputCounter + 1;
                    emit PaidCCBurn(
                        _lockerTargetAddress,
                        burnRequests[_lockerTargetAddress][_burnReqIndex].requestIdOfLocker,
                        txId,
                        _voutIndexes[i]
                    );
                }
            }
        }
    }

    /// @notice Checks the user hash script to be valid (based on its type)
    function _checkScriptType(bytes memory _userScript, ScriptTypes _scriptType) private pure {
        if (_scriptType == ScriptTypes.P2PK || _scriptType == ScriptTypes.P2WSH || _scriptType == ScriptTypes.P2TR) {
            require(_userScript.length == 32, "BurnRouter: invalid script");
        } else {
            require(_userScript.length == 20, "BurnRouter: invalid script");
        }
    }

    /// @notice Records burn request of user
    /// @param _amount Amount of wrapped token that user wants to burn
    /// @param _burntAmount Amount of wrapped token that actually gets burnt after deducting fees from the original value (_amount)
    /// @param _userScript User's Bitcoin script type
    /// @param _lastSubmittedHeight Last block header height submitted on the relay contract
    /// @param _lockerTargetAddress Locker's target chain address that the request belongs to
    function _saveBurnRequest(
        uint _amount,
        uint _burntAmount,
        bytes memory _userScript,
        ScriptTypes _scriptType,
        uint _lastSubmittedHeight,
        address _lockerTargetAddress
    ) private {
        burnRequest memory request;
        request.amount = _amount;
        request.burntAmount = _burntAmount;
        request.sender = _msgSender();
        request.userScript = _userScript;
        request.scriptType = _scriptType;
        request.deadline = _lastSubmittedHeight + transferDeadline;
        request.isTransferred = false;
        request.requestIdOfLocker = burnRequestCounter[_lockerTargetAddress];
        burnRequestCounter[_lockerTargetAddress] = burnRequestCounter[_lockerTargetAddress] + 1;
        burnRequests[_lockerTargetAddress].push(request);
    }

    /// @notice Checks inclusion of the transaction in the specified block
    /// @dev Calls the relay contract to check Merkle inclusion proof
    /// @param _amount The amount to be burnt
    /// @return Remaining amount after reducing fees
    function _getFees(
        uint _amount
    ) private returns (uint) {
        // Calculates protocol fee
        uint protocolFee = _amount * protocolPercentageFee / MAX_PROTOCOL_FEE;

        // note: to avoid dust, we require _amount to be greater than (2  * bitcoinFee)
        require(_amount > protocolFee + 2 * bitcoinFee, "BurnRouter: low amount");

        uint remainingAmount = _amount - protocolFee;

        // Transfers protocol fee
        if (protocolFee > 0) {
            require(
                ICoreBTC(coreBTC).transfer(treasury, protocolFee),
                "BurnRouter: fee transfer failed"
            );
        }

        return remainingAmount;
    }

    /// @notice Internal setter for relay contract address
    function _setRelay(address _relay) private nonZeroAddress(_relay) {
        emit NewRelay(relay, _relay);
        relay = _relay;
    }

    /// @notice                             Internal setter for lockers contract address
    /// @param _lockers                     The new lockers contract address
    function _setLockers(address _lockers) private nonZeroAddress(_lockers) {
        emit NewLockers(lockers, _lockers);
        lockers = _lockers;
    }

    /// @notice Internal setter for coreBTC contract address
    function _setCoreBTC(address _coreBTC) private nonZeroAddress(_coreBTC) {
        emit NewCoreBTC(coreBTC, _coreBTC);
        coreBTC = _coreBTC;
    }

    /// @notice Internal setter for protocol treasury address
    function _setTreasury(address _treasury) private nonZeroAddress(_treasury) {
        emit NewTreasury(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Internal setter for deadline of executing burn requests
    function _setTransferDeadline(uint _transferDeadline) private {
        uint _finalizationParameter = BurnRouterLib.finalizationParameter(relay);
        require(
            _msgSender() == owner() || transferDeadline < _finalizationParameter,
            "BurnRouter: no permit"
        );
        // Gives lockers enough time to pay cc burn requests
        require(_transferDeadline > _finalizationParameter, "BurnRouter: low deadline");
        emit NewTransferDeadline(transferDeadline, _transferDeadline);
        transferDeadline = _transferDeadline;
    }

    /// @notice Internal setter for protocol percentage fee for burning tokens
    function _setProtocolPercentageFee(uint _protocolPercentageFee) private {
        require(MAX_PROTOCOL_FEE >= _protocolPercentageFee, "BurnRouter: invalid fee");
        emit NewProtocolPercentageFee(protocolPercentageFee, _protocolPercentageFee);
        protocolPercentageFee = _protocolPercentageFee;
    }

    /// @notice Internal setter for starting block number
    function _setStartingBlockNumber(uint _startingBlockNumber) private {
        require(
            _startingBlockNumber > startingBlockNumber,
            "BurnRouter: low startingBlockNumber"
        );
        startingBlockNumber = _startingBlockNumber;
    }

    /// @notice Internal setter for slasher percentage reward for disputing lockers
    function _setSlasherPercentageReward(uint _slasherPercentageReward) private {
        require(MAX_SLASHER_REWARD >= _slasherPercentageReward, "BurnRouter: invalid reward");
        emit NewSlasherPercentageFee(slasherPercentageReward, _slasherPercentageReward);
        slasherPercentageReward = _slasherPercentageReward;
    }

    /// @notice Internal setter for Bitcoin transaction fee
    function _setBitcoinFee(uint _bitcoinFee) private {
        emit NewBitcoinFee(bitcoinFee, _bitcoinFee);
        bitcoinFee = _bitcoinFee;
    }

    /// @notice Internal setter for Bitcoin fee oracle
    function _setBitcoinFeeOracle(address _bitcoinFeeOracle) private {
        emit NewBitcoinFeeOracle(bitcoinFeeOracle, _bitcoinFeeOracle);
        bitcoinFeeOracle = _bitcoinFeeOracle;
    }

}