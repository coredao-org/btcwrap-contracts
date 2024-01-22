// SPDX-License-Identifier: MIT
pragma solidity 0.8.4;

import "./interfaces/ILockers.sol";
import "./LockersStorageStructure.sol";
import "../oracle/interfaces/IPriceOracle.sol";
import "../erc20/interfaces/ICoreBTC.sol";
import "../routers/interfaces/IBurnRouter.sol";
import "../libraries/LockersLib.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract LockersLogic is LockersStorageStructure, ILockers,
    Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {

    using LockersLib for *;
    using SafeERC20 for IERC20;

    function initialize(
        address _coreBTC,
        address _priceOracle,
        uint _minRequiredTNTLockedAmount,
        uint _collateralRatio,
        uint _liquidationRatio,
        uint _lockerPercentageFee,
        uint _priceWithDiscountRatio
    ) public initializer {

        Ownable2StepUpgradeable.__Ownable2Step_init();
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        PausableUpgradeable.__Pausable_init();
        UUPSUpgradeable.__UUPSUpgradeable_init();

        require(
            _minRequiredTNTLockedAmount != 0,
            "Lockers: amount is zero"
        );

        _setCoreBTC(_coreBTC);
        _setPriceOracle(_priceOracle);
        _setMinRequiredTNTLockedAmount(_minRequiredTNTLockedAmount);
        _setCollateralRatio(_collateralRatio);
        _setLiquidationRatio(_liquidationRatio);
        _setLockerPercentageFee(_lockerPercentageFee);
        _setPriceWithDiscountRatio(_priceWithDiscountRatio);

        libConstants.OneHundredPercent = ONE_HUNDRED_PERCENT;
        libConstants.HealthFactor = HEALTH_FACTOR;
        libConstants.UpperHealthFactor = UPPER_HEALTH_FACTOR;
        libConstants.MaxLockerFee = MAX_LOCKER_FEE;
        libConstants.NativeTokenDecimal = NATIVE_TOKEN_DECIMAL;
        libConstants.NativeToken = NATIVE_TOKEN;

    }

    // *************** Modifiers ***************

    modifier nonZeroAddress(address _address) {
        require(_address != address(0), "Lockers: address is zero");
        _;
    }

    modifier nonZeroValue(uint _value) {
        require(_value > 0, "Lockers: value is zero");
        _;
    }

    modifier onlyMinter() {
        require(isMinter(_msgSender()), "Lockers: only minters can mint");
        _;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
    // *************** External functions ***************

    /**
     * @dev Give an account access to mint.
     */
    function addMinter(address _account) external override nonZeroAddress(_account) onlyOwner {
        require(!isMinter(_account), "Lockers: account already has role");
        minters[_account] = true;
        emit MinterAdded(_account);
    }

    /**
     * @dev Remove an account's access to mint.
     */
    function removeMinter(address _account) external override nonZeroAddress(_account) onlyOwner {
        require(isMinter(_account), "Lockers: account does not have role");
        minters[_account] = false;
        emit MinterRemoved(_account);
    }

    modifier onlyBurner() {
        require(isBurner(_msgSender()), "Lockers: only burners can burn");
        _;
    }

    /**
     * @dev Give an account access to burn.
     */
    function addBurner(address _account) external override nonZeroAddress(_account) onlyOwner {
        require(!isBurner(_account), "Lockers: account already has role");
        burners[_account] = true;
        emit BurnerAdded(_account);
    }

    /**
     * @dev Remove an account's access to burn.
     */
    function removeBurner(address _account) external override nonZeroAddress(_account) onlyOwner {
        require(isBurner(_account), "Lockers: account does not have role");
        burners[_account] = false;
        emit BurnerRemoved(_account);
    }

    /// @notice                 Pause the locker, so only the functions can be called which are whenPaused
    /// @dev                    Only owner can pause
    function pauseLocker() external override onlyOwner {
        _pause();
    }

    /// @notice                 Un-pause the locker, so only the functions can be called which are whenNotPaused
    /// @dev                    Only owner can pause
    function unPauseLocker() external override onlyOwner {
        _unpause();
    }

    function getLockerTargetAddress(bytes calldata  _lockerLockingScript) external view override returns (address) {
        return lockerTargetAddress[_lockerLockingScript];
    }

    /// @notice                           Checks whether a locking script is locker
    /// @param _lockerLockingScript       Locking script of locker on the target chain
    /// @return                           True if a locking script is locker
    function isLocker(bytes calldata _lockerLockingScript) external override view returns(bool) {
        return lockersMapping[lockerTargetAddress[_lockerLockingScript]].isLocker;
    }

    /// @notice                           Give number of lockers
    /// @return                           Number of lockers
    function getNumberOfLockers() external override view returns (uint) {
        return totalNumberOfLockers;
    }

    /// @notice                             Give Bitcoin public key of locker
    /// @param _lockerTargetAddress         Address of locker on the target chain
    /// @return                             Bitcoin public key of locker
    function getLockerLockingScript(
        address _lockerTargetAddress
    ) external override view nonZeroAddress(_lockerTargetAddress) returns (bytes memory) {
        return lockersMapping[_lockerTargetAddress].lockerLockingScript;
    }

    /// @notice                       Changes percentage fee of locker
    /// @dev                          Only current owner can call this
    /// @param _lockerPercentageFee   The new locker percentage fee
    function setLockerPercentageFee(uint _lockerPercentageFee) external override onlyOwner {
        _setLockerPercentageFee(_lockerPercentageFee);
    }

    /// @notice                          Changes price with discount ratio
    /// @dev                             Only current owner can call this
    /// @param _priceWithDiscountRatio   The new price with discount ratioo
    function setPriceWithDiscountRatio(uint _priceWithDiscountRatio) external override onlyOwner {
        _setPriceWithDiscountRatio(_priceWithDiscountRatio);
    }

    /// @notice         Changes the required native token bond amount to become locker
    /// @dev            Only current owner can call this
    ///                 It should be a non-zero value
    /// @param _minRequiredTNTLockedAmount   The new required native token bond amount
    function setMinRequiredTNTLockedAmount(uint _minRequiredTNTLockedAmount) external override onlyOwner {
        _setMinRequiredTNTLockedAmount(_minRequiredTNTLockedAmount);
    }

    /// @notice                 Changes the price oracle
    /// @dev                    Only current owner can call this
    /// @param _priceOracle     The new price oracle
    function setPriceOracle(address _priceOracle) external override nonZeroAddress(_priceOracle) onlyOwner {
        _setPriceOracle(_priceOracle);
    }

    /// @notice                Changes cc burn router contract
    /// @dev                   Only current owner can call this
    /// @param _ccBurnRouter   The new cc burn router contract address
    function setCCBurnRouter(address _ccBurnRouter) external override nonZeroAddress(_ccBurnRouter) onlyOwner {
        _setCCBurnRouter(_ccBurnRouter);
    }

    /// @notice                 Changes wrapped token contract address
    /// @dev                    Only owner can call this
    /// @param _coreBTC         The new wrapped token contract address
    function setCoreBTC(address _coreBTC) external override nonZeroAddress(_coreBTC) onlyOwner {
        _setCoreBTC(_coreBTC);
    }

    /// @notice                     Changes collateral ratio
    /// @dev                        Only owner can call this
    /// @param _collateralRatio     The new collateral ratio
    function setCollateralRatio(uint _collateralRatio) external override onlyOwner {
        _setCollateralRatio(_collateralRatio);
    }

    /// @notice                     Changes liquidation ratio
    /// @dev                        Only owner can call this
    /// @param _liquidationRatio    The new liquidation ratio
    function setLiquidationRatio(uint _liquidationRatio) external override onlyOwner {
        _setLiquidationRatio(_liquidationRatio);
    }

    /// @notice                                 Adds user to candidates list
    /// @dev                                    Users mint CoreBTC by sending BTC to locker's locking script
    ///                                         In case of liqudation of locker's bond, the burn CoreBTC is sent to
    ///                                         locker's rescue script
    ///                                         A user should lock enough TNT to become candidate
    /// @param _candidateLockingScript          Locking script of the candidate
    /// @param _lockedNativeTokenAmount         Bond amount of locker in native token of the target chain
    /// @param _lockerRescueType                Type of locker's rescue script (e.g. P2SH)
    /// @param _lockerRescueScript              Rescue script of the locker
    /// @return                                 True if candidate is added successfully
    function requestToBecomeLocker(
        bytes calldata _candidateLockingScript,
        uint _lockedNativeTokenAmount,
        ScriptTypes _lockerRescueType,
        bytes calldata _lockerRescueScript
    ) external override payable nonReentrant returns (bool) {

        LockersLib.requestToBecomeLockerValidation(
                lockersMapping,
                libParams,
                lockerTargetAddress[_candidateLockingScript],
                _lockedNativeTokenAmount
            );

        totalNumberOfCandidates = totalNumberOfCandidates + 1;

        LockersLib.requestToBecomeLocker(
                lockersMapping,
                _candidateLockingScript,
                _lockedNativeTokenAmount,
                _lockerRescueType,
                _lockerRescueScript
            );

        emit RequestAddLocker(
            _msgSender(),
            _candidateLockingScript,
            _lockedNativeTokenAmount
        );

        return true;
    }

    /// @notice                       Removes a candidate from candidates list
    /// @dev                          A user who is still a candidate can revoke his/her request
    /// @return                       True if candidate is removed successfully
    function revokeRequest() external override nonReentrant returns (bool) {

        require(
            lockersMapping[_msgSender()].isCandidate,
            "Lockers: no req"
        );

        // Loads locker's information
        DataTypes.locker memory lockerRequest = lockersMapping[_msgSender()];

        // Removes candidate from lockersMapping
        delete lockersMapping[_msgSender()];
        totalNumberOfCandidates = totalNumberOfCandidates -1;

        // Sends back TNT collateral
        Address.sendValue(payable(_msgSender()), lockerRequest.nativeTokenLockedAmount);

        emit RevokeAddLockerRequest(
            _msgSender(),
            lockersMapping[_msgSender()].lockerLockingScript,
            lockersMapping[_msgSender()].nativeTokenLockedAmount
        );

        return true;
    }

    /// @notice                               Approves a candidate request to become locker
    /// @dev                                  Only owner can call this
    ///                                       When a candidate becomes locker, isCandidate is set to false
    /// @param _lockerTargetAddress           Locker's target chain address
    /// @return                               True if candidate is added successfully
    function addLocker(
        address _lockerTargetAddress
    ) external override nonZeroAddress(_lockerTargetAddress) nonReentrant onlyOwner returns (bool) {

        require(
            lockersMapping[_lockerTargetAddress].isCandidate,
            "Lockers: no request"
        );

        // Updates locker's status
        lockersMapping[_lockerTargetAddress].isCandidate = false;
        lockersMapping[_lockerTargetAddress].isLocker = true;

        // Updates number of candidates and lockers
        totalNumberOfCandidates = totalNumberOfCandidates -1;
        totalNumberOfLockers = totalNumberOfLockers + 1;

        lockerTargetAddress[lockersMapping[_lockerTargetAddress].lockerLockingScript] = _lockerTargetAddress;
        approvedLockers.push(_lockerTargetAddress);

        emit LockerAdded(
            _lockerTargetAddress,
            lockersMapping[_lockerTargetAddress].lockerLockingScript,
            lockersMapping[_lockerTargetAddress].nativeTokenLockedAmount,
            block.timestamp
        );
        return true;
    }

    /// @notice                Requests to inactivate a locker
    /// @dev                   Deactivates the locker so that no one can mint by this locker:
    ///                        1. Locker can be removed after inactivation
    ///                        2. Locker can withdraw extra collateral after inactivation
    /// @return                True if deactivated successfully
    function requestInactivation() external override nonReentrant returns (bool) {
        require(
            lockersMapping[_msgSender()].isLocker,
            "Lockers: input address is not a valid locker"
        );

        require(
            lockerInactivationTimestamp[_msgSender()] == 0,
            "Lockers: locker has already requested"
        );

        lockerInactivationTimestamp[_msgSender()] = block.timestamp + INACTIVATION_DELAY;

        emit RequestInactivateLocker(
            _msgSender(),
            lockerInactivationTimestamp[_msgSender()],
            lockersMapping[_msgSender()].lockerLockingScript,
            lockersMapping[_msgSender()].nativeTokenLockedAmount,
            lockersMapping[_msgSender()].netMinted
        );

        return true;
    }

    /// @notice                Requests to activate a locker
    /// @dev                   Activates the locker so users can mint by this locker
    ///                        note: lockerInactivationTimestamp == 0 means that the locker is active
    /// @return                True if activated successfully
    function requestActivation() external override nonReentrant returns (bool) {
        require(
            lockersMapping[_msgSender()].isLocker,
            "Lockers: input address is not a valid locker"
        );

        lockerInactivationTimestamp[_msgSender()] = 0;

        emit ActivateLocker(
            _msgSender(),
            lockersMapping[_msgSender()].lockerLockingScript,
            lockersMapping[_msgSender()].nativeTokenLockedAmount,
            lockersMapping[_msgSender()].netMinted
        );

        return true;
    }

    /// @notice                       Removes a locker from lockers list
    /// @dev                          Only locker can call this function
    /// @return                       True if locker is removed successfully
    function selfRemoveLocker() external override nonReentrant returns (bool) {
        _removeLocker(_msgSender());
        return true;
    }

    /// @notice                           Slashes lockers for not executing a cc burn req
    /// @dev                              Only cc burn router can call this
    ///                                   Locker is slashed since doesn't provide burn proof
    ///                                   before a cc burn request deadline.
    ///                                   User who made the cc burn request will receive the slashed bond
    /// @param _lockerTargetAddress       Locker's target chain address
    /// @param _rewardAmount              Amount of CoreBTC that slasher receives
    /// @param _rewardRecipient           Address of slasher who receives reward
    /// @param _amount                    Amount of CoreBTC that is slashed from lockers
    /// @param _recipient                 Address of user who receives the slashed amount
    /// @return                           True if the locker is slashed successfully
    function slashIdleLocker(
        address _lockerTargetAddress,
        uint _rewardAmount,
        address _rewardRecipient,
        uint _amount,
        address _recipient
    ) external override nonReentrant whenNotPaused returns (bool) {
        require(
            _msgSender() == ccBurnRouter,
            "Lockers: message sender is not ccBurn"
        );

        uint equivalentNativeToken = LockersLib.slashIdleLocker(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams,
            _rewardAmount,
            _amount
        );

        // Transfers TNT to user
        payable(_recipient).transfer(equivalentNativeToken*_amount/(_amount + _rewardAmount));
        // Transfers TNT to slasher
        uint rewardAmountInNativeToken = equivalentNativeToken - (equivalentNativeToken*_amount/(_amount + _rewardAmount));
        payable(_rewardRecipient).transfer(rewardAmountInNativeToken);

        emit LockerSlashed(
            _lockerTargetAddress,
            rewardAmountInNativeToken,
            _rewardRecipient,
            _amount,
            _recipient,
            equivalentNativeToken,
            block.timestamp,
            true
        );

        return true;
    }


    /// @notice                           Slashes lockers for moving BTC without a good reason
    /// @dev                              Only cc burn router can call this
    ///                                   Locker is slashed because he/she moved BTC from
    ///                                   locker's Bitcoin address without any corresponding burn req
    ///                                   The slashed bond will be sold with discount
    /// @param _lockerTargetAddress       Locker's target chain address
    /// @param _rewardAmount              Value of slashed reward (in CoreBTC)
    /// @param _rewardRecipient           Address of slasher who receives reward
    /// @param _amount                    Value of slashed collateral (in CoreBTC)
    /// @return                           True if the locker is slashed successfully
    function slashThiefLocker(
        address _lockerTargetAddress,
        uint _rewardAmount,
        address _rewardRecipient,
        uint _amount
    ) external override nonReentrant whenNotPaused returns (bool) {
        require(
            _msgSender() == ccBurnRouter,
            "Lockers: message sender is not ccBurn"
        );

        (uint rewardInNativeToken, uint neededNativeTokenForSlash) = LockersLib.slashThiefLocker(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams,
            _rewardAmount,
            _amount
        );

        payable(_rewardRecipient).transfer(rewardInNativeToken);

        emit LockerSlashed(
            _lockerTargetAddress,
            rewardInNativeToken,
            _rewardRecipient,
            _amount,
            address(this),
            neededNativeTokenForSlash + rewardInNativeToken,
            block.timestamp,
            false
        );

        return true;
    }

    /// @notice                           Liquidates the locker whose collateral is unhealthy
    /// @dev                              Anyone can liquidate a locker whose health factor
    ///                                   is less than 10000 (100%) by providing a sufficient amount of coreBTC
    /// @param _lockerTargetAddress       Locker's target chain address
    /// @param _collateralAmount          Amount of collateral (TNT) that someone intends to buy with discount
    /// @return                           True if liquidation was successful
    function liquidateLocker(
        address _lockerTargetAddress,
        uint _collateralAmount
    ) external override nonZeroAddress(_lockerTargetAddress) nonZeroValue(_collateralAmount)
    nonReentrant whenNotPaused returns (bool) {

        uint neededCoreBTC = LockersLib.liquidateLocker(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams,
            _collateralAmount
        );

        DataTypes.locker memory theLiquidatingLocker = lockersMapping[_lockerTargetAddress];

        // Updates TNT bond of locker
        lockersMapping[_lockerTargetAddress].nativeTokenLockedAmount =
            lockersMapping[_lockerTargetAddress].nativeTokenLockedAmount - _collateralAmount;

        // transfer coreBTC from user
        IERC20(coreBTC).safeTransferFrom(msg.sender, address(this), neededCoreBTC);

        // Burns CoreBTC for locker rescue script
        IERC20(coreBTC).approve(ccBurnRouter, neededCoreBTC);
        IBurnRouter(ccBurnRouter).ccBurn(
            neededCoreBTC,
            theLiquidatingLocker.lockerRescueScript,
            theLiquidatingLocker.lockerRescueType,
            theLiquidatingLocker.lockerLockingScript
        );

        Address.sendValue(payable(_msgSender()), _collateralAmount);

        emit LockerLiquidated(
            _lockerTargetAddress,
            _msgSender(),
            _collateralAmount,
            neededCoreBTC,
            block.timestamp
        );

        return true;
    }

    /// @notice                           Sells lockers slashed collateral
    /// @dev                              Users buy the slashed collateral using CoreBTC with discount
    ///                                   The paid CoreBTC will be burnt to keep the system safe
    ///                                   If all the needed CoreBTC is collected and burnt,
    ///                                   the rest of slashed collateral is sent back to locker
    /// @param _lockerTargetAddress       Locker's target chain address
    /// @param _collateralAmount          Amount of collateral (TNT) that someone intends to buy with discount
    /// @return                           True if buying was successful
    function buySlashedCollateralOfLocker(
        address _lockerTargetAddress,
        uint _collateralAmount
    ) external nonZeroAddress(_lockerTargetAddress)
        nonReentrant whenNotPaused override returns (bool) {

        uint neededCoreBTC = LockersLib.buySlashedCollateralOfLocker(
            lockersMapping[_lockerTargetAddress],
            _collateralAmount
        );

        // Burns user's CoreBTC
        ICoreBTC(coreBTC).transferFrom(_msgSender(), address(this), neededCoreBTC);
        ICoreBTC(coreBTC).burn(neededCoreBTC);

        // Sends bought collateral to user
        Address.sendValue(payable(_msgSender()), _collateralAmount);

        emit LockerSlashedCollateralSold(
            _lockerTargetAddress,
            _msgSender(),
            _collateralAmount,
            neededCoreBTC,
            block.timestamp
        );

        return true;
    }


    /// @notice                                 Increases TNT collateral of the locker
    /// @param _lockerTargetAddress             Locker's target chain address
    /// @param _addingNativeTokenAmount         Amount of added collateral
    /// @return                                 True if collateral is added successfully
    function addCollateral(
        address _lockerTargetAddress,
        uint _addingNativeTokenAmount
    ) external override payable nonReentrant returns (bool) {

        require(
            msg.value == _addingNativeTokenAmount,
            "Lockers: msg value"
        );

        LockersLib.addToCollateral(
            lockersMapping[_lockerTargetAddress],
            _addingNativeTokenAmount
        );

        emit CollateralAdded(
            _lockerTargetAddress,
            _addingNativeTokenAmount,
            lockersMapping[_lockerTargetAddress].nativeTokenLockedAmount,
            block.timestamp
        );

        return true;
    }

    /// @notice                                 Decreases TNT collateral of the locker
    /// @param _removingNativeTokenAmount       Amount of removed collateral
    /// @return                                 True if collateral is removed successfully
    function removeCollateral(
        uint _removingNativeTokenAmount
    ) external override payable nonReentrant returns (bool) {
        address _sender = _msgSender();
        require(
            lockersMapping[_sender].isLocker,
            "Lockers: no locker"
        );

        require(
            !isLockerActive(_sender),
            "Lockers: still active"
        );

        uint priceOfOnUnitOfCollateral = LockersLib.priceOfOneUnitOfCollateralInBTC(
            libConstants,
            libParams
        );

        LockersLib.removeFromCollateral(
            lockersMapping[_sender],
            libConstants,
            libParams,
            priceOfOnUnitOfCollateral,
            _removingNativeTokenAmount
        );

        Address.sendValue(payable(_sender), _removingNativeTokenAmount);

        emit CollateralRemoved(
            _sender,
            _removingNativeTokenAmount,
            lockersMapping[_sender].nativeTokenLockedAmount,
            block.timestamp
        );

        return true;
    }

    /// @notice                       Mint coreBTC for an account
    /// @dev                          Mint coreBTC for an account and the locker fee as well
    /// @param _lockerLockingScript   Locking script of a locker
    /// @param _receiver              Address of the receiver of the minted coreBTCs
    /// @param _txId                  The id of bitcoin transaction
    /// @param _amount                Amount of the coreBTC which is minted, including the locker's fee
    /// @return uint                  The amount of coreBTC minted for the receiver
    function mint(
        bytes calldata _lockerLockingScript,
        address _receiver,
        bytes32 _txId,
        uint _amount
    ) external override nonZeroAddress(_receiver)
    nonZeroValue(_amount) nonReentrant whenNotPaused onlyMinter returns (uint) {

        address _lockerTargetAddress = lockerTargetAddress[_lockerLockingScript];

        uint theLockerCapacity = getLockerCapacity(_lockerTargetAddress);

        require(
            theLockerCapacity >= _amount,
            "Lockers: insufficient capacity"
        );

        require(
            isLockerActive(_lockerTargetAddress),
            "Lockers: not active"
        );

        lockersMapping[_lockerTargetAddress].netMinted =
            lockersMapping[_lockerTargetAddress].netMinted + _amount;

        // Mints locker fee
        uint lockerFee = _amount*lockerPercentageFee/MAX_LOCKER_FEE;
        if (lockerFee > 0) {
            ICoreBTC(coreBTC).mint(_lockerTargetAddress, lockerFee);
        }

        // Mints tokens for receiver
        ICoreBTC(coreBTC).mint(_receiver, _amount - lockerFee);

        emit MintByLocker(
            _lockerTargetAddress,
            _receiver,
            _txId,
            _amount,
            lockerFee,
            block.timestamp
        );

        return _amount - lockerFee;
    }

    /// @notice                       Burn coreBTC of an account
    /// @dev                          Burn coreBTC and also get the locker's fee
    /// @param _lockerLockingScript   Locking script of a locker
    /// @param _amount                Amount of the coreBTC which is minted, including the locker's fee
    /// @return uint                  The amount of coreBTC burnt
    function burn(
        bytes calldata _lockerLockingScript,
        uint _amount
    ) external override nonZeroValue(_amount)
    whenNotPaused onlyBurner returns (uint) {

        address _lockerTargetAddress = lockerTargetAddress[_lockerLockingScript];

        // Transfers coreBTC from user
        require(
            ICoreBTC(coreBTC).transferFrom(_msgSender(), address(this), _amount),
            "Lockers: transferFrom failed"
        );

        uint lockerFee = _amount*lockerPercentageFee/MAX_LOCKER_FEE;
        uint remainedAmount = _amount - lockerFee;
        uint netMinted = lockersMapping[_lockerTargetAddress].netMinted;

        require(
            netMinted >= remainedAmount,
            "Lockers: insufficient funds"
        );

        lockersMapping[_lockerTargetAddress].netMinted = netMinted - remainedAmount;

        // Burns coreBTC and sends rest of it to locker
        require(
            ICoreBTC(coreBTC).burn(remainedAmount),
            "Lockers: burn failed"
        );
        require(
            ICoreBTC(coreBTC).transfer(_lockerTargetAddress, lockerFee),
            "Lockers: lockerFee failed"
        );

        emit BurnByLocker(
            _lockerTargetAddress,
            _amount,
            lockerFee,
            block.timestamp
        );

        return remainedAmount;
    }

    // *************** Public functions ***************

    function renounceOwnership() public virtual override onlyOwner {}

    /// @notice                             Returns the Locker status
    /// @dev                                We check a locker status in below cases:
    ///                                     1. Minting CoreBTC
    ///                                     2. Removing locker's collateral
    ///                                     3. Removing locker
    /// @param _lockerTargetAddress         Address of locker on the target chain
    /// @return                             True if the locker is active
    function isLockerActive(
        address _lockerTargetAddress
    ) public override view nonZeroAddress(_lockerTargetAddress) returns (bool) {
        if (lockerInactivationTimestamp[_lockerTargetAddress] == 0) {
            return true;
        } else if (lockerInactivationTimestamp[_lockerTargetAddress] > block.timestamp) {
            return true;
        } else {
            return false;
        }
    }

    /// @notice                             Get how much the locker can mint
    /// @dev                                Net minted amount is total minted minus total burnt for the locker
    /// @param _lockerTargetAddress         Address of locker on the target chain
    /// @return                             The net minted of the locker
    function getLockerCapacity(
        address _lockerTargetAddress
    ) public override view nonZeroAddress(_lockerTargetAddress) returns (uint) {

        return LockersLib.getLockerCapacity(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams
        );
    }

    /**
     * @dev         Returns the price of one native token (1*10^18) in coreBTC
     * @return uint The price of one unit of collateral token (native token in coreBTC)
     */
    function priceOfOneUnitOfCollateralInBTC() public override view returns (uint) {

        return LockersLib.priceOfOneUnitOfCollateralInBTC(
            libConstants,
            libParams
        );

    }

    /// @notice                Check if an account is minter
    /// @param  account        The account which intended to be checked
    /// @return bool
    function isMinter(address account) public override view nonZeroAddress(account) returns (bool) {
        return minters[account];
    }

    /// @notice                Check if an account is burner
    /// @param  account        The account which intended to be checked
    /// @return bool
    function isBurner(address account) public override view nonZeroAddress(account) returns (bool) {
        return burners[account];
    }

    /// @notice                             Get health factor of the locker
    /// @dev                                The health factor is equal to current collateral asset value divided by the minimum collateral asset value to trigger liquidation,
    ///                                     the minimum collateral asset value to trigger liquidation is equal to the current locked asset value multiplied by the liquidation ratio
    /// @param _lockerTargetAddress         Address of locker on the target chain
    /// @return                             The health factor of the locker
    function getHealthFactor(address _lockerTargetAddress) external override view returns(uint) {
        return LockersLib.getHealthFactor(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams
        );
    }

    /// @notice                             Get maximum buyable collateral amount of the locker
    /// @param _lockerTargetAddress         Address of locker on the target chain
    /// @return                             The maximum buyable collateral amount of the locker
    function getMaximumBuyableCollateral(address _lockerTargetAddress) external override view returns (uint) {
        return LockersLib.getMaximumBuyableCollateral(
            lockersMapping[_lockerTargetAddress],
            libConstants,
            libParams
        );
    }

    /// @notice                             Get how much coreBTC needed for buying the collateral
    /// @param _collateralAmount            Amount of collateral (TNT) that someone intends to buy with discount
    /// @return                             The amount of coreBTC
    function getNeededCoreBTCToBuyCollateral(uint _collateralAmount) external override view returns(uint) {
        return LockersLib.getNeededCoreBTCToBuyCollateral(
            libConstants,
            libParams,
            _collateralAmount
        );
    }


    // *************** Private functions ***************

    /// @notice                       Removes a locker from lockers list
    /// @dev                          Checks that net minted CoreBTC of locker is zero
    ///                               Sends back available bond of locker (in TDT and TNT)
    /// @param _lockerTargetAddress   Target address of locker to be removed
    function _removeLocker(address _lockerTargetAddress) private {

        require(
            lockersMapping[_lockerTargetAddress].isLocker,
            "Lockers: no locker"
        );

        require(
            !isLockerActive(_lockerTargetAddress),
            "Lockers: still active"
        );

        require(
            lockersMapping[_lockerTargetAddress].netMinted == 0,
            "Lockers: 0 net minted"
        );

        require(
            lockersMapping[_lockerTargetAddress].slashingCoreBTCAmount == 0,
            "Lockers: 0 slashing TBTC"
        );

        DataTypes.locker memory _removingLocker = lockersMapping[_lockerTargetAddress];

        // Removes locker from lockersMapping

        delete lockerTargetAddress[lockersMapping[_lockerTargetAddress].lockerLockingScript];
        delete lockersMapping[_lockerTargetAddress];
        _removeApprovedLocker(_lockerTargetAddress);
        totalNumberOfLockers = totalNumberOfLockers - 1;

        // Sends back TNT collateral
        Address.sendValue(payable(_lockerTargetAddress), _removingLocker.nativeTokenLockedAmount);

        emit LockerRemoved(
            _lockerTargetAddress,
            _removingLocker.lockerLockingScript,
            _removingLocker.nativeTokenLockedAmount
        );

    }

    /// @notice                       Internal setter for percentage fee of locker
    /// @param _lockerPercentageFee   The new locker percentage fee
    function _setLockerPercentageFee(uint _lockerPercentageFee) private {
        require(_lockerPercentageFee <= MAX_LOCKER_FEE, "Lockers: invalid locker fee");
        emit NewLockerPercentageFee(lockerPercentageFee, _lockerPercentageFee);
        lockerPercentageFee = _lockerPercentageFee;
        libParams.lockerPercentageFee = lockerPercentageFee;
    }

    function _setPriceWithDiscountRatio(uint _priceWithDiscountRatio) private {
        require(
            _priceWithDiscountRatio <= ONE_HUNDRED_PERCENT,
            "Lockers: less than 100%"
        );
        emit NewPriceWithDiscountRatio(priceWithDiscountRatio, _priceWithDiscountRatio);

        priceWithDiscountRatio= _priceWithDiscountRatio;
        libParams.priceWithDiscountRatio = priceWithDiscountRatio;
    }

    /// @notice         Internal setter for the required bond amount to become locker
    /// @param _minRequiredTNTLockedAmount   The new required bond amount
    function _setMinRequiredTNTLockedAmount(uint _minRequiredTNTLockedAmount) private {
        require(
            _minRequiredTNTLockedAmount != 0,
            "Lockers: amount is zero"
        );
        emit NewMinRequiredTNTLockedAmount(minRequiredTNTLockedAmount, _minRequiredTNTLockedAmount);
        minRequiredTNTLockedAmount = _minRequiredTNTLockedAmount;
        libParams.minRequiredTNTLockedAmount = minRequiredTNTLockedAmount;
    }

    /// @notice                 Internal setter for the price oracle
    /// @param _priceOracle     The new price oracle
    function _setPriceOracle(address _priceOracle) private nonZeroAddress(_priceOracle) {
        emit NewPriceOracle(priceOracle, _priceOracle);
        priceOracle = _priceOracle;
        libParams.priceOracle = priceOracle;
    }

    /// @notice                Internal setter for cc burn router contract
    /// @param _ccBurnRouter   The new cc burn router contract address
    function _setCCBurnRouter(address _ccBurnRouter) private nonZeroAddress(_ccBurnRouter) {
        emit NewCCBurnRouter(ccBurnRouter, _ccBurnRouter);
        emit BurnerRemoved(ccBurnRouter);
        burners[ccBurnRouter] = false;
        ccBurnRouter = _ccBurnRouter;
        libParams.ccBurnRouter = ccBurnRouter;
        emit BurnerAdded(ccBurnRouter);
        burners[ccBurnRouter] = true;
    }

    /// @notice                 Internal setter for wrapped token contract address
    /// @param _coreBTC         The new wrapped token contract address
    function _setCoreBTC(address _coreBTC) private nonZeroAddress(_coreBTC) {
        emit NewCoreBTC(coreBTC, _coreBTC);
        coreBTC = _coreBTC;
        libParams.coreBTC = coreBTC;
    }

    /// @notice                     Internal setter for collateral ratio
    /// @param _collateralRatio     The new collateral ratio
    function _setCollateralRatio(uint _collateralRatio) private {
        require(_collateralRatio > liquidationRatio, "Lockers: must CR > LR");
        emit NewCollateralRatio(collateralRatio, _collateralRatio);
        collateralRatio = _collateralRatio;
        libParams.collateralRatio = collateralRatio;
    }

    /// @notice                     Internal setter for liquidation ratio
    /// @param _liquidationRatio    The new liquidation ratio
    function _setLiquidationRatio(uint _liquidationRatio) private {
        // require(
        //     _liquidationRatio >= ONE_HUNDRED_PERCENT,
        //     "Lockers: problem in CR and LR"
        // );
        require(
            collateralRatio > _liquidationRatio,
            "Lockers: must CR > LR"
        );
        emit NewLiquidationRatio(liquidationRatio, _liquidationRatio);
        liquidationRatio = _liquidationRatio;
        libParams.liquidationRatio = liquidationRatio;
    }

    /// @notice                       Removes a locker from approved locker list
    /// @param _lockerTargetAddress   Target address of locker to be removed
    function _removeApprovedLocker(address _lockerTargetAddress) private {
        uint len = approvedLockers.length;
        uint i = 0;
        for (; i < len; i++) {
            if (approvedLockers[i] == _lockerTargetAddress) {
                break;
            }
        }

        if (i == len) return;

        if (i < len - 1) {
            approvedLockers[i] = approvedLockers[len-1];
        }
        approvedLockers.pop();
    }

}
