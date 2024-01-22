// SPDX-License-Identifier: MIT
pragma solidity 0.8.4;

import "./interfaces/ICoreBTC.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract CoreBTCLogic is ICoreBTC, ERC20Upgradeable, 
    Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {

    modifier onlyBlackLister() {
        require(isBlackLister(_msgSender()), "CoreBTC: only blacklisters");
        _;
    }

    modifier notBlackListed(address _account) {
        require(!isBlackListed(_account), "CoreBTC: blacklisted");
        _;
    }
 
    modifier onlyMinter() {
        require(isMinter(_msgSender()), "CoreBTC: only minters can mint");
        _;
    }

    modifier onlyBurner() {
        require(isBurner(_msgSender()), "CoreBTC: only burners can burn");
        _;
    }

    modifier nonZeroValue(uint _value) {
        require(_value > 0, "CoreBTC: value is zero");
        _;
    }

    // Public variables
    mapping(address => bool) public minters;
    mapping(address => bool) public burners;
    mapping(address => bool) public blacklisters;

    mapping(address => bool) internal blacklisted;

    uint public maxMintLimit; // Maximum mint limit per epoch
    uint public lastMintLimit; // Current mint limit in last epoch, decrease by minting in an epoch
    uint public epochLength; // Number of blocks in every epoch
    uint public lastEpoch; // Epoch number of last mint transaction

    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory _name,
        string memory _symbol
    ) public initializer {
        ERC20Upgradeable.__ERC20_init(
            _name,
            _symbol
        );
        Ownable2StepUpgradeable.__Ownable2Step_init();
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        UUPSUpgradeable.__UUPSUpgradeable_init();

        maxMintLimit = 10 ** 8;
        lastMintLimit = 10 ** 8;
        epochLength = 2000;
    }

    function renounceOwnership() public virtual override onlyOwner {}

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function decimals() public view virtual override(ERC20Upgradeable, ICoreBTC) returns (uint8) {
        return 8;
    }

    /**
     * @dev change maximum mint limit per epoch.
     */
    function setMaxMintLimit(uint _mintLimit) public override onlyOwner {
        emit NewMintLimit(maxMintLimit, _mintLimit);
        maxMintLimit = _mintLimit;
    }

    /**
     * @dev change blocks number per epoch.
     */
    function setEpochLength(uint _length) public override onlyOwner nonZeroValue(_length) {
        emit NewEpochLength(epochLength, _length);
        epochLength = _length;
    }

    /**
     * @dev Check if an account is blacklister.
     * @return bool
     */
    function isBlackLister(address account) internal view returns (bool) {
        require(account != address(0), "CoreBTC: zero address");
        return blacklisters[account];
    }

    /**
     * @dev Check if an account is blacklisted.
     * @return bool
     */
    function isBlackListed(address account) public view returns (bool) {
        // require(account != address(0), "CoreBTC: zero address");
        return blacklisted[account];
    }

    /**
     * @dev Check if an account is minter.
     * @return bool
     */
    function isMinter(address account) internal view returns (bool) {
        require(account != address(0), "CoreBTC: zero address");
        return minters[account];
    }

    /// @notice                Check if an account is burner    
    /// @param  account        The account which intended to be checked
    /// @return bool
    function isBurner(address account) internal view returns (bool) {
        require(account != address(0), "CoreBTC: zero address");
        return burners[account];
    }

    /// @notice                Adds a blacklister
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be added to blacklisters
    function addBlackLister(address account) external override onlyOwner {
        require(!isBlackLister(account), "CoreBTC: already has role");
        blacklisters[account] = true;
        emit BlackListerAdded(account);
    }

    /// @notice                Removes a blacklister
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be removed from blacklisters
    function removeBlackLister(address account) external override onlyOwner {
        require(isBlackLister(account), "CoreBTC: does not have role");
        blacklisters[account] = false;
        emit BlackListerRemoved(account);
    }

    /// @notice                Adds a minter
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be added to minters
    function addMinter(address account) external override onlyOwner {
        require(!isMinter(account), "CoreBTC: already has role");
        minters[account] = true;
        emit MinterAdded(account);
    }

    /// @notice                Removes a minter
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be removed from minters
    function removeMinter(address account) external override onlyOwner {
        require(isMinter(account), "CoreBTC: does not have role");
        minters[account] = false;
        emit MinterRemoved(account);
    }

    /// @notice                Adds a burner
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be added to burners
    function addBurner(address account) external override onlyOwner {
        require(!isBurner(account), "CoreBTC: already has role");
        burners[account] = true;
        emit BurnerAdded(account);
    }

    /// @notice                Removes a burner
    /// @dev                   Only owner can call this function
    /// @param  account        The account which intended to be removed from burners
    function removeBurner(address account) external override onlyOwner {
        require(isBurner(account), "CoreBTC: does not have role");
        burners[account] = false;
        emit BurnerRemoved(account);
    }

    /// @notice                Burns CoreBTC tokens of msg.sender
    /// @dev                   Only burners can call this
    /// @param _amount         Amount of burnt tokens
    function burn(uint _amount) external nonReentrant onlyBurner override returns (bool) {
        _burn(_msgSender(), _amount);
        emit Burn(_msgSender(), _msgSender(), _amount);
        return true;
    }

    /// @notice                Burns CoreBTC tokens of user
    /// @dev                   Only owner can call this
    /// @param _user           Address of user whose coreBTC is burnt
    /// @param _amount         Amount of burnt tokens
    function ownerBurn(address _user, uint _amount) external nonReentrant onlyOwner override returns (bool) {

        if (isBlackListed(_user)) {
            blacklisted[_user] = false;
            _burn(_user, _amount);
            blacklisted[_user] = true;
        } else {
            _burn(_user, _amount);
        }
        
        emit Burn(owner(), _user, _amount);
        return true;
    }

    /// @notice                Mints CoreBTC tokens for _receiver
    /// @dev                   Only minters can call this
    /// @param _receiver       Address of token's receiver
    /// @param _amount         Amount of minted tokens
    function mint(address _receiver, uint _amount) external nonReentrant onlyMinter override returns (bool) {
        require(_amount <= maxMintLimit, "CoreBTC: mint amount is more than maximum mint limit");
        require(checkAndReduceMintLimit(_amount), "CoreBTC: reached maximum mint limit");

        _mint(_receiver, _amount);
        emit Mint(_msgSender(), _receiver, _amount);
        return true;
    }

    /// @notice                Check if can mint new tokens and update mint limit
    /// @param _amount         Desired mint amount
    function checkAndReduceMintLimit(uint _amount) private returns (bool) {
        uint currentEpoch = block.number / epochLength;
        
        if (currentEpoch == lastEpoch) {
            if (_amount > lastMintLimit)
                return false;
            lastMintLimit -= _amount;
        } else {
            lastEpoch = currentEpoch;
            lastMintLimit = maxMintLimit - _amount;
        }
        return true;
    }

    /// @notice                Blacklist an account
    /// @dev                   Only Blacklisters can call this
    /// @param _account        Account blacklisted
    function blacklist(address _account) external override nonReentrant onlyBlackLister {
        blacklisted[_account] = true;
        emit Blacklisted(_account);
    }

    /// @notice                UnBlacklist an account
    /// @dev                   Only Blacklisters can call this
    /// @param _account        Account unblacklisted
    function unBlacklist(address _account) external override nonReentrant onlyBlackLister {
        blacklisted[_account] = false;
        emit UnBlacklisted(_account);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 /*amount*/
    ) internal view override {
        require(!isBlackListed(from), "CoreBTC: from is blacklisted");
        require(!isBlackListed(to), "CoreBTC: to is blacklisted");
    }
}