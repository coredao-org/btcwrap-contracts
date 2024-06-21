import Web3 from "web3";

require('dotenv').config({path: "../../.env"});

import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber} from "ethers";
import {deployMockContract, MockContract} from "@ethereum-waffle/mock-contract";
import {Contract} from "@ethersproject/contracts";
import {Address} from "hardhat-deploy/types";

import {LockersProxy__factory} from "../src/types/factories/LockersProxy__factory";
import {LockersLogic__factory} from "../src/types/factories/LockersLogic__factory";
import {LockersLogicLibraryAddresses} from "../src/types/factories/LockersLogic__factory";

import {LockersLib} from "../src/types/LockersLib";
import {LockersLib__factory} from "../src/types/factories/LockersLib__factory";

import {CoreBTCLogic} from "../src/types/CoreBTCLogic";
import {CoreBTCLogic__factory} from "../src/types/factories/CoreBTCLogic__factory";
import {CoreBTCProxy__factory} from "../src/types/factories/CoreBTCProxy__factory";
import {advanceBlockWithTime, takeSnapshot, revertProvider} from "./block_utils";
import {CollateralsLogic__factory} from "../src/types/factories/CollateralsLogic__factory";
import {CollateralsProxy__factory} from "../src/types/factories/CollateralsProxy__factory";
import {CollateralsLogic, IERC20} from "../src/types";
import {Erc20} from "../src/types/ERC20";
import {Erc20__factory} from "../src/types/factories/Erc20__factory";


describe("Lockers", async () => {

    let snapshotId: any;

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let minRequiredNativeTokenLockedAmount = BigNumber.from(10).pow(18).mul(5);
    let btcAmountToSlash = BigNumber.from(10).pow(8).mul(1)
    let collateralRatio = 20000;
    let liquidationRatio = 15000;
    let NATIVE_TOKEN = "0x0000000000000000000000000000000000000001";
    let TWO_ADDRESS = "0x0000000000000000000000000000000000000002";
    let TX_ID = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const LOCKER_PERCENTAGE_FEE = 20; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9500; // Means %95
    const INACTIVATION_DELAY = 355600;
    const ONE_HUNDRED_PERCENT = 10000;

    // Bitcoin public key (32 bytes)
    let LOCKER1 = '0x03789ed0bb717d88f7d321a368d905e7430207ebbd82bd342cf11ae157a7ace5fd';
    let LOCKER1_PUBKEY__HASH = '0x4062c8aeed4f81c2d73ff854a2957021191e20b6';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let REQUIRED_LOCKED_AMOUNT = 1000; // amount of required TDT

    // Accounts
    let proxyAdmin: Signer;
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let signer3: Signer;
    let ccBurnSimulator: Signer;
    let deployerAddress: Address;
    let signer1Address: Address;
    let signer2Address: Address;
    let signer3Address: Address;
    let erc20Address: Address;
    let _erc20Address: Address;

    let ccBurnSimulatorAddress: Address;

    // Contracts
    let lockersLib: LockersLib;
    let lockers: Contract;
    let lockers2: Contract;
    let coreBTC: CoreBTCLogic;
    let collateral: CollateralsLogic;
    let erc20: Erc20;
    let _erc20: Erc20;

    // Mock contracts
    let mockPriceOracle: MockContract;
    let mockCCBurnRouter: MockContract;

    before(async () => {
        // Sets accounts
        [proxyAdmin, deployer, signer1, signer2, ccBurnSimulator, signer3] = await ethers.getSigners();
        deployerAddress = await deployer.getAddress();
        signer1Address = await signer1.getAddress();
        signer2Address = await signer2.getAddress();
        signer3Address = await signer3.getAddress();
        ccBurnSimulatorAddress = await ccBurnSimulator.getAddress();

        const priceOracleContract = await deployments.getArtifact(
            "IPriceOracle"
        );
        mockPriceOracle = await deployMockContract(
            deployer,
            priceOracleContract.abi
        );

        const ccBurnRouterContract = await deployments.getArtifact(
            "BurnRouterLogic"
        );
        mockCCBurnRouter = await deployMockContract(
            deployer,
            ccBurnRouterContract.abi
        );

        // Deploys lockers contract
        lockers = await deployLockers();
        lockers2 = await deployLockers();

        coreBTC = await deployCoreBTC();
        collateral = await deployCollateral();
        await collateral.initialize(lockers.address, minRequiredNativeTokenLockedAmount);
        // Initializes lockers proxy
        await lockers.initialize(
            coreBTC.address,
            mockPriceOracle.address,
            collateralRatio,
            liquidationRatio,
            LOCKER_PERCENTAGE_FEE,
            PRICE_WITH_DISCOUNT_RATIO
        )

        // Sets ccBurnRouter address
        await lockers.setCCBurnRouter(ccBurnSimulatorAddress)
        lockers.setCollaterals(collateral.address);

        await coreBTC.addMinter(deployerAddress)
        await coreBTC.addMinter(signer1Address)
        await coreBTC.addMinter(lockers.address)
        await coreBTC.addBurner(lockers.address)
        const erc20Factory = new Erc20__factory(deployer);
        erc20 = await erc20Factory.deploy(
            "TestToken",
            "TT",
            BigNumber.from(10).pow(18).mul(50)
        );
        erc20Address = erc20.address;
        _erc20 = await erc20Factory.deploy(
            "NewToken",
            "NT",
            BigNumber.from(10).pow(18).mul(50)
        );
        _erc20Address = _erc20.address;
        // add TestToken as collateral
        await collateral.addCollateral(erc20.address, minRequiredNativeTokenLockedAmount);
    });

    beforeEach(async () => {
        // Takes snapshot
        snapshotId = await takeSnapshot(deployer.provider);
    });

    afterEach(async () => {
        // Reverts the state
        await revertProvider(deployer.provider, snapshotId);
    });

    async function getTimestamp(): Promise<number> {
        let lastBlockNumber = await ethers.provider.getBlockNumber();
        let lastBlock = await ethers.provider.getBlock(lastBlockNumber);
        return lastBlock.timestamp;
    }


    async function approveToLocker(sender: Signer, amount: BigNumber, lockedToken: Contract): Promise<void> {
        await lockedToken.connect(sender).approve(lockers.address, amount);
    }

    async function becomeLockerCandidate(sender: Signer, lockedAmount: BigNumber, lockedToken: Address): Promise<void> {
        const senderAddress = await sender.getAddress()
        let TokenContract = erc20
        if (lockedToken != NATIVE_TOKEN) {
            if (lockedToken === _erc20Address) {
                TokenContract = _erc20
            }
            // transfer the balance to sender
            await TokenContract.connect(deployer).transfer(senderAddress, lockedAmount)
            // authorized locker can be transferred
            await approveToLocker(sender, lockedAmount, TokenContract)
        }
        // apply to be a Locker candidate
        await lockers.connect(sender).requestToBecomeLocker(
            LOCKER1_PUBKEY__HASH,
            lockedAmount,
            LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
            LOCKER_RESCUE_SCRIPT_P2PKH,
            lockedToken,
            {value: lockedAmount}
        )
    }


    const deployCollateral = async (
        _signer?: Signer
    ): Promise<CollateralsLogic> => {
        const collateralLogicFactory = new CollateralsLogic__factory(
            deployer
        );
        const collateralLogic = await collateralLogicFactory.deploy();
        // Deploys lockers proxy
        const CollateralProxyFactory = new CollateralsProxy__factory(
            deployer
        );
        const collateralProxy = await CollateralProxyFactory.deploy(
            collateralLogic.address,
            "0x"
        )
        const collateralsLogic = await collateralLogic.attach(
            collateralProxy.address
        );
        return collateralsLogic;
    };

    const deployCoreBTC = async (
        _signer?: Signer
    ): Promise<CoreBTCLogic> => {
        const coreBTCLogicFactory = new CoreBTCLogic__factory(deployer);
        const coreBTCLogicImpl = await coreBTCLogicFactory.deploy();
        const methodSig = ethers.utils.id(
            "initialize(string,string)"
        );
        const tokenName = "coreBTC";
        const tokenSymbol = "CBTC";
        const params = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string'],
            [tokenName, tokenSymbol]
        );
        const initCode = ethers.utils.solidityPack(
            ['bytes', 'bytes'],
            [methodSig.slice(0, 10), params]
        );
        const coreBTCProxyFactory = new CoreBTCProxy__factory(deployer);
        const coreBTCProxy = await coreBTCProxyFactory.deploy(
            coreBTCLogicImpl.address,
            initCode
        );
        coreBTC = await coreBTCLogicFactory.attach(
            coreBTCProxy.address
        )
        return coreBTC;
    };

    const deployLockersLib = async (
        _signer?: Signer
    ): Promise<LockersLib> => {
        const LockersLibFactory = new LockersLib__factory(
            _signer || deployer
        );

        const lockersLib = await LockersLibFactory.deploy(
        );

        return lockersLib;
    };


    const deployLockers = async (
        _signer?: Signer
    ): Promise<Contract> => {

        lockersLib = await deployLockersLib()

        let linkLibraryAddresses: LockersLogicLibraryAddresses;

        linkLibraryAddresses = {
            "contracts/libraries/LockersLib.sol:LockersLib": lockersLib.address,
        };

        // Deploys lockers logic
        const lockersLogicFactory = new LockersLogic__factory(
            linkLibraryAddresses,
            _signer || deployer
        );

        const lockersLogic = await lockersLogicFactory.deploy();

        // Deploys lockers proxy
        const lockersProxyFactory = new LockersProxy__factory(
            _signer || deployer
        );
        const lockersProxy = await lockersProxyFactory.deploy(
            lockersLogic.address,
            "0x"
        )

        const lockers = await lockersLogic.attach(
            lockersProxy.address
        );

        return lockers;
    };

    describe("#initialize", async () => {

        it("initialize can be called only once", async function () {
            await expect(
                lockers.initialize(
                    coreBTC.address,
                    mockPriceOracle.address,
                    collateralRatio,
                    liquidationRatio,
                    LOCKER_PERCENTAGE_FEE,
                    PRICE_WITH_DISCOUNT_RATIO
                )
            ).to.be.revertedWith("Initializable: contract is already initialized")
        })

        it("initialize cant be called with zero address", async function () {
            await expect(
                lockers2.initialize(
                    coreBTC.address,
                    ZERO_ADDRESS,
                    collateralRatio,
                    liquidationRatio,
                    LOCKER_PERCENTAGE_FEE,
                    PRICE_WITH_DISCOUNT_RATIO
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })


        it("initialize cant be called LR greater than CR", async function () {
            await expect(
                lockers2.initialize(
                    coreBTC.address,
                    mockPriceOracle.address,
                    liquidationRatio,
                    collateralRatio,
                    LOCKER_PERCENTAGE_FEE,
                    PRICE_WITH_DISCOUNT_RATIO
                )
            ).to.be.revertedWith("Lockers: must CR > LR")
        })

        it("initialize cant be called with Price discount greater than 100%", async function () {
            await expect(
                lockers2.initialize(
                    coreBTC.address,
                    mockPriceOracle.address,
                    collateralRatio,
                    liquidationRatio,
                    LOCKER_PERCENTAGE_FEE,
                    PRICE_WITH_DISCOUNT_RATIO + 10000
                )
            ).to.be.revertedWith("Lockers: less than or equal to 100%")
        })

    })

    describe("#addMinter", async () => {

        it("can't add zero address as minter", async function () {
            await expect(
                lockers.addMinter(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("only owner can add a minter", async function () {

            let lockersSigner1 = await lockers.connect(signer1)

            await expect(
                lockersSigner1.addMinter(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("owner successfully adds a minter", async function () {

            await expect(
                await lockers.addMinter(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "MinterAdded"
            ).withArgs(ONE_ADDRESS);
        })

        it("can't add an account that already is minter", async function () {

            await lockers.addMinter(
                ONE_ADDRESS
            )

            await expect(
                lockers.addMinter(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Lockers: account already has role")
        })

    })

    describe("#removeMinter", async () => {

        it("can't remove zero address as minter", async function () {
            await expect(
                lockers.removeMinter(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("only owner can add a minter", async function () {

            let lockersSigner1 = await lockers.connect(signer1)

            await expect(
                lockersSigner1.removeMinter(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("owner can't remove an account from minter that it's not minter ATM", async function () {

            await expect(
                lockers.removeMinter(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Lockers: account does not have role")
        })

        it("owner successfully removes an account from minters", async function () {

            await lockers.addMinter(
                ONE_ADDRESS
            )

            await expect(
                await lockers.removeMinter(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "MinterRemoved"
            ).withArgs(ONE_ADDRESS);
        })

    })

    describe("#addBurner", async () => {

        it("can't add zero address as burner", async function () {
            await expect(
                lockers.addBurner(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("only owner can add a burner", async function () {

            let lockersSigner1 = await lockers.connect(signer1)

            await expect(
                lockersSigner1.addBurner(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("owner successfully adds a burner", async function () {

            await expect(
                await lockers.addBurner(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "BurnerAdded"
            ).withArgs(ONE_ADDRESS);
        })

        it("can't add an account that already is burner", async function () {

            await lockers.addBurner(
                ONE_ADDRESS
            )

            await expect(
                lockers.addBurner(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Lockers: account already has role")
        })

    })

    describe("#removeBurner", async () => {

        it("can't remove zero address as burner", async function () {
            await expect(
                lockers.removeBurner(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("only owner can add a burner", async function () {

            let lockersSigner1 = await lockers.connect(signer1)

            await expect(
                lockersSigner1.removeBurner(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("owner can't remove an account from burners that it's not burner ATM", async function () {

            await expect(
                lockers.removeBurner(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Lockers: account does not have role")
        })

        it("owner successfully removes an account from burner", async function () {

            await lockers.addBurner(
                ONE_ADDRESS
            )

            await expect(
                await lockers.removeBurner(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "BurnerRemoved"
            ).withArgs(ONE_ADDRESS);
        })

    })

    describe("#pauseLocker", async () => {

        it("only admin can pause locker", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.pauseLocker()
            ).to.be.revertedWith("Ownable: caller is not the owner")

        });

        it("contract paused successsfully", async function () {
            let lockerSigner1 = lockers.connect(signer1)
            await lockers.pauseLocker()
            await expect(
                lockerSigner1.slashIdleLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    10000,
                    ccBurnSimulatorAddress
                )
            ).to.be.revertedWith("Pausable: paused")
            await expect(
                lockerSigner1.slashThiefLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

            await expect(
                lockerSigner1.liquidateLocker(
                    signer1Address,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

            await expect(
                lockerSigner1.buySlashedCollateralOfLocker(
                    signer1Address,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

            await expect(
                lockerSigner1.mint(
                    signer1Address,
                    signer2Address,
                    TX_ID,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

            await expect(
                lockerSigner1.burn(
                    signer1Address,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

        });

        it("can't pause when already paused", async function () {

            await lockers.pauseLocker()

            await expect(
                lockers.pauseLocker()
            ).to.be.revertedWith("Pausable: paused")

        });

    });

    describe("#unPauseLocker", async () => {

        it("only admin can un-pause locker", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.unPauseLocker()
            ).to.be.revertedWith("Ownable: caller is not the owner")

        });

        it("can't un-pause when already un-paused", async function () {

            await expect(
                lockers.unPauseLocker()
            ).to.be.revertedWith("Pausable: not paused")

        });

        it("contract un-paused successsfully", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await lockers.pauseLocker()

            await expect(
                lockerSigner1.liquidateLocker(
                    signer1Address,
                    10000
                )
            ).to.be.revertedWith("Pausable: paused")

            await lockers.unPauseLocker()

            await expect(
                lockerSigner1.liquidateLocker(
                    signer1Address,
                    10000
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")

        });

    });

    describe("#setLockerPercentageFee", async () => {

        it("non owners can't call setLockerPercentageFee", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setLockerPercentageFee(
                    2100
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setLockerPercentageFee", async function () {

            await expect(
                await lockers.setLockerPercentageFee(
                    2100
                )
            ).to.emit(
                lockers, "NewLockerPercentageFee"
            ).withArgs(LOCKER_PERCENTAGE_FEE, 2100);

            expect(
                await lockers.lockerPercentageFee()
            ).to.equal(2100)
        })
    })

    describe("#setSlashCompensationRatio", async () => {

        it("non owners can't call setSlashCompensationRatio", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setSlashCompensationRatio(
                    100
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setSlashCompensationRatio", async function () {

            await expect(
                await lockers.setSlashCompensationRatio(
                    105
                )
            ).to.emit(
                lockers, "NewSlashCompensationRatio"
            ).withArgs(0, 105);
            expect(
                await lockers.slashCompensationRatio()
            ).to.equal(105)
        })
        it("reverts if compensation rate is greater than 100", async function () {

            await expect(
                lockers.setSlashCompensationRatio(
                    10001
                )
            ).to.be.revertedWith('Lockers: less than or equal to 100%')
        })
    })

    describe("#setCollaterals", async () => {

        it("non owners can't call setCollaterals", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setCollaterals(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setCollaterals", async function () {

            await expect(
                lockers.setCollaterals(
                    TWO_ADDRESS
                )
            ).to.emit(
                lockers, "NewCollaterals"
            )
            expect(
                await lockers.collaterals()
            ).to.equal(TWO_ADDRESS)
        })
        it("Reverts when address is zero", async function () {

            await expect(
                lockers.setCollaterals(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith('Lockers: address is zero')

        })

    })

    describe("#setPriceWithDiscountRatio", async () => {

        it("non owners can't call setPriceWithDiscountRatio", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setPriceWithDiscountRatio(
                    2100
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setPriceWithDiscountRatio", async function () {

            await expect(
                await lockers.setPriceWithDiscountRatio(
                    2100
                )
            ).to.emit(
                lockers, "NewPriceWithDiscountRatio"
            ).withArgs(PRICE_WITH_DISCOUNT_RATIO, 2100);

            expect(
                await lockers.priceWithDiscountRatio()
            ).to.equal(2100)
        })
    })

    describe("#setPriceOracle", async () => {

        it("price oracle can't be zero address", async function () {

            await expect(
                lockers.setPriceOracle(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("non owners can't call setPriceOracle", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setPriceOracle(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setPriceOracle", async function () {

            await expect(
                await lockers.setPriceOracle(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "NewPriceOracle"
            ).withArgs(mockPriceOracle.address, ONE_ADDRESS);


            expect(
                await lockers.priceOracle()
            ).to.equal(ONE_ADDRESS)
        })
    })


    describe("#setCCBurnRouter", async () => {

        it("cc burn router can't be zero address", async function () {

            await expect(
                lockers.setCCBurnRouter(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("non owners can't call setCCBurnRouter", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setCCBurnRouter(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setCCBurnRouter", async function () {

            await expect(
                await lockers.setCCBurnRouter(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "NewCCBurnRouter"
            ).withArgs(ccBurnSimulatorAddress, ONE_ADDRESS);

            expect(
                await lockers.ccBurnRouter()
            ).to.equal(ONE_ADDRESS)
        })
    })

    describe("#setCoreBTC", async () => {

        it("core BTC can't be zero address", async function () {

            await expect(
                lockers.setCoreBTC(
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("non owners can't call setCoreBTC", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setCoreBTC(
                    ONE_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setCoreBTC", async function () {

            await expect(
                await lockers.setCoreBTC(
                    ONE_ADDRESS
                )
            ).to.emit(
                lockers, "NewCoreBTC"
            ).withArgs(coreBTC.address, ONE_ADDRESS);

            expect(
                await lockers.coreBTC()
            ).to.equal(ONE_ADDRESS)
        })
    })

    describe("#setCollateralRatio", async () => {

        it("non owners can't call setCollateralRatio", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setCollateralRatio(
                    1234
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setCollateralRatio", async function () {

            await expect(
                await lockers.setCollateralRatio(
                    21000
                )
            ).to.emit(
                lockers, "NewCollateralRatio"
            ).withArgs(collateralRatio, 21000);

            expect(
                await lockers.collateralRatio()
            ).to.equal(21000)
        })
    })

    describe("#setLiquidationRatio", async () => {

        it("non owners can't call setLiquidationRatio", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.setLiquidationRatio(
                    1234
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("only owner can call setLiquidationRatio", async function () {

            await expect(
                await lockers.setLiquidationRatio(
                    19000
                )
            ).to.emit(
                lockers, "NewLiquidationRatio"
            ).withArgs(liquidationRatio, 19000);

            expect(
                await lockers.liquidationRatio()
            ).to.equal(19000)
        })
    })

    describe("#requestToBecomeLocker", async () => {
        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            await erc20.transfer(signer1Address, minRequiredNativeTokenLockedAmount.mul(10))
        });
        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });
        it("Reverts on low collateral quantity", async function () {
            let lockerSigner1 = lockers.connect(signer1);
            let lockedAmount = minRequiredNativeTokenLockedAmount.sub(10);
            const error = `InsufficientCollateral("${NATIVE_TOKEN}", ${lockedAmount}, ${minRequiredNativeTokenLockedAmount})`;
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    // LOCKER1,
                    LOCKER1_PUBKEY__HASH,
                    lockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: lockedAmount}
                )
            ).to.be.revertedWith(error)
        })
        it("ensures value and NativeTokenLockedAmount are not equal", async function () {
            let lockerSigner1 = lockers.connect(signer1)
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    // LOCKER1,
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: minRequiredNativeTokenLockedAmount.sub(1)}
                )
            ).to.be.revertedWith("Lockers: incorrect CORE amount")
        })

        it("successful request to become locker", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                await lockerSigner1.requestToBecomeLocker(
                    // LOCKER1,
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.emit(lockers, "RequestAddLocker").withArgs(
                signer1Address,
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                NATIVE_TOKEN
            )

            expect(
                await lockers.totalNumberOfCandidates()
            ).to.equal(1)

        })
        it("blocks duplicate requests in the locker", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await lockerSigner1.requestToBecomeLocker(
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                NATIVE_TOKEN,
                {value: minRequiredNativeTokenLockedAmount}
            )
            // approval as a locker
            await lockers.addLocker(signer1Address)
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: minRequiredNativeTokenLockedAmount}
                )).to.be.revertedWith('Lockers: is locker')
        })

        it("a locker can't requestToBecomeLocker twice", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await lockerSigner1.requestToBecomeLocker(
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                NATIVE_TOKEN,
                {value: minRequiredNativeTokenLockedAmount}
            )

            await expect(
                lockerSigner1.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.be.revertedWith("Lockers: is candidate")

        })


        it("a redeem script hash can't be used twice", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await lockerSigner1.requestToBecomeLocker(
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                NATIVE_TOKEN,
                {value: minRequiredNativeTokenLockedAmount}
            )

            await lockers.addLocker(signer1Address)

            let lockerSigner2 = lockers.connect(signer2)

            await expect(
                lockerSigner2.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    NATIVE_TOKEN,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.be.revertedWith("Lockers: used locking script")

        })
        it("Successfully becomes locker with non-native token collateral", async function () {
            let lockerSigner1 = lockers.connect(signer1);
            await approveToLocker(signer1, minRequiredNativeTokenLockedAmount, erc20);
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    erc20.address,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.be.emit(lockers, 'RequestAddLocker').withArgs(
                signer1Address,
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                erc20.address
            )
            let lockerBalance = await erc20.balanceOf(lockers.address)
            expect(lockerBalance).to.equal(minRequiredNativeTokenLockedAmount);
            let totalNumberOfCandidates = await lockerSigner1.totalNumberOfCandidates()
            expect(totalNumberOfCandidates).to.equal(1);
            await expect(collateral.removeCollateral(erc20.address)).to.revertedWith('Lockers: collateral in use')
            let _locker = await lockerSigner1.lockersMapping(signer1Address)
            expect(_locker.lockedAmount).to.equal(minRequiredNativeTokenLockedAmount);
            expect(_locker.isLocker).to.equal(false);
            expect(_locker.isScriptHash).to.equal(false);
            expect(_locker.isCandidate).to.equal(true);
            expect(_locker.lockedToken).to.equal(erc20.address);

        })
        it("Reverts when approvedAmount of non-native token collateral is insufficient", async function () {
            let lockerSigner1 = lockers.connect(signer1);
            await approveToLocker(signer1, minRequiredNativeTokenLockedAmount.sub(1), erc20);
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    erc20.address,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.be.revertedWith('ERC20: insufficient allowance')


        })
        it("Reverts when applying locker with unsupported collateral", async function () {
            let lockerSigner1 = lockers.connect(signer1);
            await expect(
                lockerSigner1.requestToBecomeLocker(
                    LOCKER1_PUBKEY__HASH,
                    minRequiredNativeTokenLockedAmount,
                    LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                    LOCKER_RESCUE_SCRIPT_P2PKH,
                    _erc20.address,
                    {value: minRequiredNativeTokenLockedAmount}
                )
            ).to.be.revertedWith('Lockers: unsupported collateral')
        })


    });

    describe("#revokeRequest", async () => {

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            await erc20.transfer(signer1Address, minRequiredNativeTokenLockedAmount)
            await erc20.transfer(signer2Address, minRequiredNativeTokenLockedAmount)
            await erc20.transfer(signer3Address, minRequiredNativeTokenLockedAmount)
        });
        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        })

        it("trying to revoke a non existing request", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.revokeRequest()
            ).to.be.revertedWith("Lockers: no req")
        })

        it("successful revoke (native token)", async function () {
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            let candidateLocker = await lockers.candidateLockers(0)
            expect(candidateLocker).to.equal(signer1Address)
            let signer1Balance1 = await signer1.getBalance();
            await expect(lockerSigner1.revokeRequest()).to.be.emit(lockers, 'RevokeAddLockerRequest').withArgs(
                signer1Address,
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                NATIVE_TOKEN
            )
            await expect(lockers.candidateLockers(0)).to.reverted;
            expect(await lockers.totalNumberOfCandidates()).to.equal(0);
            let signer1Balance2 = await signer1.getBalance();
            let diff = signer1Balance2.sub(signer1Balance1)
            expect(diff).to.gt(BigNumber.from(10).pow(18).mul(4));
        })
        it("Successfully revokes from multiple candidates", async function () {
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await becomeLockerCandidate(signer2, minRequiredNativeTokenLockedAmount, erc20.address);
            await becomeLockerCandidate(signer3, minRequiredNativeTokenLockedAmount, erc20.address);
            expect(await lockers.totalNumberOfCandidates()).to.equal(3);
            // expect(candidateLocker).eq(signer1Address)
            await expect(lockers.connect(signer1).revokeRequest()).to.be.emit(lockers, 'RevokeAddLockerRequest').withArgs(
                signer1Address,
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                NATIVE_TOKEN
            )
            let candidateLocker0 = await lockers.candidateLockers(0)
            let candidateLocker1 = await lockers.candidateLockers(1)
            expect(candidateLocker0).to.equal(signer3Address)
            expect(candidateLocker1).to.equal(signer2Address)
            expect(await lockers.totalNumberOfCandidates()).to.equal(2);
            await expect(lockers.candidateLockers(2)).to.reverted
            await lockers.connect(signer2).revokeRequest()
            expect(await lockers.candidateLockers(0)).to.equal(signer3Address)
            await expect(lockers.candidateLockers(1)).to.reverted
        })
        it("successful revoke (non-native token)", async function () {
            let lockerSigner1 = lockers.connect(signer1);
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20.address);
            let signer1BalanceBefore = await erc20.balanceOf(signer1Address);
            let candidateLocker = await lockers.candidateLockers(0);
            expect(candidateLocker).to.equal(signer1Address);
            await expect(lockerSigner1.revokeRequest()).to.be.emit(lockers, 'RevokeAddLockerRequest').withArgs(
                signer1Address,
                LOCKER1_PUBKEY__HASH,
                minRequiredNativeTokenLockedAmount,
                erc20.address
            )
            await expect(lockers.candidateLockers(0)).to.reverted;
            let lockerMap = await lockers.lockersMapping(signer1Address);
            expect(lockerMap.lockedToken).to.equal(ZERO_ADDRESS);
            let totalNumberOfCandidates = await lockers.totalNumberOfCandidates()
            expect(totalNumberOfCandidates).to.equal(0);
            let signer1BalanceAfter = await erc20.balanceOf(signer1Address);
            expect(signer1BalanceAfter.sub(signer1BalanceBefore)).to.equal(minRequiredNativeTokenLockedAmount);
        })


    });

    describe("#addLocker", async () => {
        it("non owners can't call addLocker", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.addLocker(signer1Address)
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })

        it("trying to add a non existing request as a locker", async function () {
            await expect(
                lockers.addLocker(signer1Address)
            ).to.be.revertedWith("Lockers: no request")
        })

        it("adding a locker (native token as collateral)", async function () {
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN)
            await expect(lockers.candidateLockers(0)).to.not.reverted;
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")
            expect(
                await lockers.totalNumberOfCandidates()
            ).to.equal(0)

            expect(
                await lockers.totalNumberOfLockers()
            ).to.equal(1)
            let theLockerMapping = await lockers.lockersMapping(signer1Address)
            expect(
                theLockerMapping.lockerLockingScript
            ).to.equal(LOCKER1_PUBKEY__HASH)
            expect(
                theLockerMapping.lockedToken
            ).to.equal(NATIVE_TOKEN)
            expect(
                await lockers.getLockerTargetAddress(
                    LOCKER1_PUBKEY__HASH
                )
            ).to.equal(signer1Address)

            expect(
                await lockers.isLocker(
                    LOCKER1_PUBKEY__HASH
                )
            ).to.equal(true)

            expect(
                await lockers.getLockerLockingScript(
                    signer1Address
                )
            ).to.equal(LOCKER1_PUBKEY__HASH)
            await expect(lockers.candidateLockers(0)).to.reverted;
            expect(await lockers.approvedLockers(0)).to.equal(signer1Address);
        })
        it("adding a locker (non-native token as collateral)", async function () {
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address)
            await expect(
                lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")
            expect(
                await lockers.totalNumberOfCandidates()
            ).to.equal(0)

            expect(
                await lockers.totalNumberOfLockers()
            ).to.equal(1)
            let theLockerMapping = await lockers.lockersMapping(signer1Address)
            expect(
                theLockerMapping.lockerLockingScript
            ).to.equal(LOCKER1_PUBKEY__HASH)
            expect(
                theLockerMapping.lockedToken
            ).to.equal(erc20Address)

            expect(
                await lockers.getLockerTargetAddress(
                    LOCKER1_PUBKEY__HASH
                )
            ).to.equal(signer1Address)

            expect(
                await lockers.isLocker(
                    LOCKER1_PUBKEY__HASH
                )
            ).to.equal(true)

            expect(
                await lockers.getLockerLockingScript(
                    signer1Address
                )
            ).to.equal(LOCKER1_PUBKEY__HASH)
        })

        it("Reverts when adding duplicate lockerLockingScript", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await becomeLockerCandidate(signer2, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await lockers.addLocker(signer1Address);
            await expect(lockers.addLocker(signer2Address)).to.be.revertedWith('Lockers: used locking script');
        })

    });

    describe("#requestInactivation", async () => {

        it("trying to request to remove a non existing locker", async function () {
            let lockerSigner1 = lockers.connect(signer1)
            await expect(
                lockerSigner1.requestInactivation()
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("successfully request to be removed", async function () {
            let inactivationDelay = 345600
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN)
            await lockers.addLocker(signer1Address)
            await expect(lockerSigner1.requestInactivation()
            ).to.emit(lockers, "RequestInactivateLocker")
            let theLockerMapping = await lockers.lockersMapping(signer1Address)
            let lastBlockTimestamp = await getTimestamp();
            expect(theLockerMapping.inactivationTimestamp).equal(lastBlockTimestamp + inactivationDelay)
            await expect(
                lockerSigner1.requestInactivation()
            ).to.be.revertedWith("Lockers: locker has already requested")
        })

    });

    describe("#requestActivation", async () => {

        it("trying to activate a non existing locker", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.requestActivation()
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("successfully request to be activated", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN)
            await lockers.addLocker(signer1Address)

            await expect(
                await lockerSigner1.requestInactivation()
            ).to.emit(lockers, "RequestInactivateLocker")

            await expect(
                lockerSigner1.requestActivation()
            ).to.emit(lockers, "ActivateLocker")
            let theLockerMapping = await lockers.lockersMapping(signer1Address)
            expect(theLockerMapping.inactivationTimestamp).equal(0)
        })

    });

    describe("#selfRemoveLocker", async () => {

        it("a non-existing locker can't be removed", async function () {

            let lockerSigner1 = await lockers.connect(signer1)

            await expect(
                lockerSigner1.selfRemoveLocker()
            ).to.be.revertedWith("Lockers: no locker")
        })

        it("can't remove a locker if it doesn't request to be removed", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN)
            await lockers.addLocker(signer1Address)

            await expect(
                lockerSigner1.selfRemoveLocker()
            ).to.be.revertedWith("Lockers: still active")
        })

        it("Successfully removes a locker with native token collateral", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address)

            await lockerSigner1.requestInactivation()
            await advanceBlockWithTime(deployer.provider, INACTIVATION_DELAY);
            let beforeBalance = await signer1.getBalance()
            await expect(
                await lockerSigner1.selfRemoveLocker()
            ).to.emit(lockers, "LockerRemoved")
            expect(
                await lockers.totalNumberOfLockers()
            ).to.equal(0)
            let afterBalance = await signer1.getBalance()
            expect(afterBalance.sub(beforeBalance)).to.gt(BigNumber.from(10).pow(18).mul(4))


        })
        it("Successfully removes a locker with CustomToken collateral", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address)
            await lockerSigner1.requestInactivation()
            await advanceBlockWithTime(deployer.provider, INACTIVATION_DELAY);
            await expect(
                await lockerSigner1.selfRemoveLocker()
            ).to.emit(lockers, "LockerRemoved")
            expect(
                await lockers.totalNumberOfLockers()
            ).to.equal(0)
            expect(await erc20.balanceOf(signer1Address)).to.equal(minRequiredNativeTokenLockedAmount);
            let theLockerMapping = await lockers.lockersMapping(signer1Address)
            let lockerTargetAddress = await lockers.lockerTargetAddress(LOCKER1_PUBKEY__HASH)
            expect(theLockerMapping.lockedToken).equal(ZERO_ADDRESS)
            expect(lockerTargetAddress).equal(ZERO_ADDRESS)
        })


        it("the locker can't be removed because netMinted is not zero", async function () {

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await lockers.addLocker(signer1Address)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000);
            await lockers.addMinter(signer2Address);
            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 1000);

            await lockerSigner1.requestInactivation();
            // Forwards block.timestamp to inactivate locker
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);

            await expect(
                lockerSigner1.selfRemoveLocker()
            ).to.be.revertedWith("Lockers: 0 net minted")
        })
        it("cannot remove locker when slashing TBTC is greater than 0", async function () {
            let TNTAmount = 10000;
            let CoreBTCAmount = 1000;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TNTAmount)
            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);
            // Locker mints some CoreBTC and gets BTC on Bitcoin

            await lockers.addMinter(signer1Address);

            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);
            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = lockers.connect(ccBurnSimulator)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(minRequiredNativeTokenLockedAmount.div(5))
            await lockerCCBurnSigner.slashThiefLocker(
                signer1Address,
                0,
                deployerAddress,
                CoreBTCAmount
            );
            let theLocker = await lockers.lockersMapping(signer1Address)
            expect(theLocker[5]).to.equal(CoreBTCAmount)
            await lockerSigner1.requestInactivation();
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);
            await expect(lockerSigner1.selfRemoveLocker()).to.be.revertedWith('Lockers: 0 slashing COREBTC')

        })

    });


    describe("#slashIdleLocker", async () => {

        it("only cc burn can call slash locker function", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.slashIdleLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    btcAmountToSlash,
                    ccBurnSimulatorAddress
                )
            ).to.be.revertedWith("Lockers: message sender is not ccBurn")
        })

        it("slash locker reverts when the target address is not locker", async function () {
            let lockerCCBurnSimulator = lockers.connect(ccBurnSimulator)

            await expect(
                lockerCCBurnSimulator.slashIdleLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    btcAmountToSlash,
                    ccBurnSimulatorAddress
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("can't slash more than collateral", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(
                BigNumber.from(10).pow(18).mul(6)
            )
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            let lockerCCBurnSigner = lockers.connect(ccBurnSimulator)
            let ccBurnSimulatorBalance = await ccBurnSimulator.getBalance()
            let deployerBalance = await deployer.getBalance()
            await expect(
                await lockerCCBurnSigner.slashIdleLocker(
                    signer1Address,
                    10000,
                    deployerAddress,
                    10000,
                    ccBurnSimulatorAddress
                )
            ).to.emit(lockerCCBurnSigner, "LockerSlashed")
            let theLocker = await lockers.lockersMapping(signer1Address)
            expect(theLocker[3]).to.equal(0)
            let currentCcBurnSimulatorBalance = await ccBurnSimulator.getBalance()
            let currentDeployerBalance = await deployer.getBalance()
            expect(currentCcBurnSimulatorBalance).to.be.gt(ccBurnSimulatorBalance)
            expect(currentDeployerBalance).to.be.gt(deployerBalance)
        })

        it("cc burn can slash a locker", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(BigNumber.from(10).pow(18).mul(2))
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")

            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)

            await expect(
                await lockerCCBurnSigner.slashIdleLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    10000,
                    ccBurnSimulatorAddress
                )
            ).to.emit(lockers, "LockerSlashed")
            let theLocker = await lockers.lockersMapping(signer1Address)
            let nativeTokenLockedAmount = BigNumber.from(10).pow(18).mul(3)
            expect(theLocker[3]).to.equal(nativeTokenLockedAmount)
        })
        it("cc burn can slash a locker with custom token collateral", async function () {
            let rewardAmountInCustomToken = BigNumber.from(10).pow(18).mul(3)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(rewardAmountInCustomToken)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);
            let lockerCCBurnSigner = lockers.connect(ccBurnSimulator)
            const currentBlock = await ethers.provider.getBlock('latest');
            const timestamp = currentBlock.timestamp + 1;
            let rewardAmount = 4000
            let amount = 6000
            let totalAmount = rewardAmount + amount

            await expect(
                lockerCCBurnSigner.slashIdleLocker(
                    signer1Address,
                    rewardAmount,
                    signer3Address,
                    amount,
                    ccBurnSimulatorAddress
                )
            ).to.emit(lockers, "LockerSlashed").withArgs(
                signer1Address,
                rewardAmountInCustomToken.mul(rewardAmount).div(totalAmount),
                signer3Address,
                amount,
                ccBurnSimulatorAddress,
                rewardAmountInCustomToken,
                timestamp,
                true,
                erc20Address
            )
            let reportReward = await erc20.balanceOf(signer3Address)
            let compensationAmount = await erc20.balanceOf(ccBurnSimulatorAddress)
            expect(reportReward).equal(rewardAmountInCustomToken.mul(rewardAmount).div(totalAmount))
            expect(compensationAmount).equal(rewardAmountInCustomToken.mul(amount).div(totalAmount))
        })


        it("Provides additional compensation when slashing idle locker", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(BigNumber.from(10).pow(18).mul(2))
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")
            let rewardAmountInNativeToken = BigNumber.from(10).pow(18).mul(2)
            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)
            await lockers.setSlashCompensationRatio(100)
            let amount1 = 10000 * 10100 / 10000
            const currentBlock = await ethers.provider.getBlock('latest');
            const timestamp = currentBlock.timestamp + 1;
            await expect(
                await lockerCCBurnSigner.slashIdleLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    10000,
                    ccBurnSimulatorAddress
                )
            ).to.emit(lockers, "LockerSlashed").withArgs(
                signer1Address,
                0,
                deployerAddress,
                amount1,
                ccBurnSimulatorAddress,
                rewardAmountInNativeToken,
                timestamp,
                true,
                NATIVE_TOKEN
            )
            let theLocker = await lockers.lockersMapping(signer1Address)
            let nativeTokenLockedAmount = BigNumber.from(10).pow(18).mul(3)
            expect(theLocker[3]).to.equal(nativeTokenLockedAmount)
        })
    });

    describe("#slashThiefLocker", async () => {

        it("only cc burn can call slash locker function", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.slashThiefLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    btcAmountToSlash
                )
            ).to.be.revertedWith("Lockers: message sender is not ccBurn")
        })

        it("slash locker reverts when the target address is not locker", async function () {
            let lockerCCBurnSimulator = lockers.connect(ccBurnSimulator)

            await expect(
                lockerCCBurnSimulator.slashThiefLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    btcAmountToSlash
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("cc burn can slash a locker", async function () {
            let TntAmount = BigNumber.from(10).pow(18).mul(20)
            let CoreBTCAmount = 500;
            let rewardAmount = 100;

            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TntAmount);
            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1);
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount.mul(10), NATIVE_TOKEN);
            await lockers.addLocker(signer1Address);
            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);
            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);

            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = lockers.connect(ccBurnSimulator)
            let beforeBalance = await signer3.getBalance()
            await expect(
                await lockerCCBurnSigner.slashThiefLocker(
                    signer1Address,
                    rewardAmount,
                    signer3Address,
                    CoreBTCAmount
                )
            ).to.emit(lockers, "LockerSlashed")
            let afterBalance = await signer3.getBalance();
            let reportReward = afterBalance.sub(beforeBalance);
            expect(reportReward).equal(TntAmount.div(5));
            let theLocker = await lockers.lockersMapping(signer1Address);
            expect(theLocker.reservedTokenForSlash).equal(TntAmount.mul(liquidationRatio).div(ONE_HUNDRED_PERCENT));
            expect(theLocker.slashingCoreBTCAmount).equal(500);

        })

        it("cc burn can slash a locker with custom token collateral", async function () {
            let TntAmount = BigNumber.from(10).pow(18).mul(2)
            let CoreBTCAmount = 500;
            let rewardAmount = 100;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TntAmount);
            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1);
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);
            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);
            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);

            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = lockers.connect(ccBurnSimulator)
            let beforeBalance = await erc20.balanceOf(signer3Address);
            await expect(
                await lockerCCBurnSigner.slashThiefLocker(
                    signer1Address,
                    rewardAmount,
                    signer3Address,
                    CoreBTCAmount
                )
            ).to.emit(lockers, "LockerSlashed")
            let afterBalance = await erc20.balanceOf(signer3Address);
            let reportReward = afterBalance.sub(beforeBalance);
            expect(reportReward).equal(TntAmount.div(5));
            let theLocker = await lockers.lockersMapping(signer1Address);
            expect(theLocker.reservedTokenForSlash).equal(TntAmount.mul(liquidationRatio).div(ONE_HUNDRED_PERCENT));
            expect(theLocker.lockedToken).equal(erc20Address);
        })
    });

    describe("#buySlashedCollateralOfLocker", async () => {

        it("reverts when the target address is not locker", async function () {
            let lockerSigner1 = lockers.connect(signer1)

            await expect(
                lockerSigner1.buySlashedCollateralOfLocker(
                    signer1Address,
                    10
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("not enough slashed amount to buy", async function () {

            let TNTAmount = 10000;
            let CoreBTCAmount = 1000;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TNTAmount)

            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")

            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);
            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);

            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)

            await expect(
                await lockerCCBurnSigner.slashThiefLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    CoreBTCAmount
                )
            ).to.emit(lockerCCBurnSigner, "LockerSlashed")


            // Someone buys slashed collateral with discount
            let lockerSigner2 = lockers.connect(signer2)
            await expect(
                lockerSigner2.buySlashedCollateralOfLocker(
                    signer1Address,
                    TNTAmount * liquidationRatio + 1
                )
            ).to.be.revertedWith("Lockers: not enough slashed collateral to buy")

        })

        it("can't slash because needed BTC is more than existing", async function () {

            let TNTAmount = 10000;
            let CoreBTCAmount = 1000;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TNTAmount)

            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")

            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);
            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);

            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(minRequiredNativeTokenLockedAmount.div(5))

            await expect(
                await lockerCCBurnSigner.slashThiefLocker(
                    signer1Address,
                    0,
                    deployerAddress,
                    CoreBTCAmount
                )
            ).to.emit(lockerCCBurnSigner, "LockerSlashed")

            // Someone buys slashed collateral with discount
            let lockerSigner2 = lockers.connect(signer2)
            await expect(
                lockerSigner2.buySlashedCollateralOfLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(1)
                )
            ).to.be.reverted

        })

        it("can buy slashing amount", async function () {

            let TNTAmount = 10000;
            let CoreBTCAmount = 1000;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TNTAmount)

            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await expect(
                await lockers.addLocker(signer1Address)
            ).to.emit(lockers, "LockerAdded")

            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);
            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);

            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(minRequiredNativeTokenLockedAmount.div(5))

            await lockerCCBurnSigner.slashThiefLocker(
                signer1Address,
                0,
                deployerAddress,
                CoreBTCAmount
            );

            let theLocker = await lockers.lockersMapping(signer1Address)

            expect(
                theLocker[5]
            ).to.equal(CoreBTCAmount)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(CoreBTCAmount)

            await coreBTC.mint(signer2Address, 10000000)

            let coreBTCSigner2 = await coreBTC.connect(signer2);

            await coreBTCSigner2.approve(lockers.address, 1 + CoreBTCAmount * 95 / 100) // add 1 bcz of precision loss

            // Someone buys slashed collateral with discount
            let lockerSigner2 = lockers.connect(signer2)
            await expect(
                await lockerSigner2.buySlashedCollateralOfLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(1)
                )
            ).to.emit(lockers, "LockerSlashedCollateralSold")
        })
        it("can buy slashing amount (custom token as collateral)", async function () {

            let TNTAmount = 10000;
            let CoreBTCAmount = 1000;
            // Initialize mock contract (how much TNT locker should be penalized)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(TNTAmount)

            // Signer 1 becomes a locker
            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address)

            // Locker mints some CoreBTC and gets BTC on Bitcoin
            await lockers.addMinter(signer1Address);

            await lockerSigner1.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, CoreBTCAmount);
            // ccBurn calls to slash the locker
            let lockerCCBurnSigner = await lockers.connect(ccBurnSimulator)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(minRequiredNativeTokenLockedAmount.div(5))

            await lockerCCBurnSigner.slashThiefLocker(
                signer1Address,
                0,
                deployerAddress,
                CoreBTCAmount
            );

            await mockPriceOracle.mock.equivalentOutputAmount.returns(CoreBTCAmount);
            await coreBTC.mint(signer2Address, 10000000)
            let coreBTCSigner2 = await coreBTC.connect(signer2);

            await coreBTCSigner2.approve(lockers.address, 1 + CoreBTCAmount * 95 / 100) // add 1 bcz of precision loss

            // Someone buys slashed collateral with discount
            let lockerSigner2 = lockers.connect(signer2)
            await expect(
                await lockerSigner2.buySlashedCollateralOfLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(1)
                )
            ).to.emit(lockers, "LockerSlashedCollateralSold")
            let reportReward = await erc20.balanceOf(signer2Address)
            expect(reportReward).equal(BigNumber.from(10).pow(18).mul(1));
        })
    });

    describe("#mint", async () => {

        let amount;

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Mints core BTC", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            amount = 1000;
            let lockerFee = Math.floor(amount * LOCKER_PERCENTAGE_FEE / 10000);

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, amount);

            let theLockerMapping = await lockers.lockersMapping(signer1Address);

            expect(
                theLockerMapping[4]
            ).to.equal(1000);

            // Checks that enough coreBTC has been minted for user
            expect(
                await coreBTC.balanceOf(ONE_ADDRESS)
            ).to.equal(amount - lockerFee);

            // Checks that enough coreBTC has been minted for locker
            expect(
                await coreBTC.balanceOf(signer1Address)
            ).to.equal(lockerFee);
        })

        it("Mints core BTC (custom token as collateral)", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            amount = 1000;
            let lockerFee = Math.floor(amount * LOCKER_PERCENTAGE_FEE / 10000);

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, amount);

            let theLockerMapping = await lockers.lockersMapping(signer1Address);
            expect(
                theLockerMapping.netMinted
            ).to.equal(1000);

            // Checks that enough coreBTC has been minted for user
            expect(
                await coreBTC.balanceOf(ONE_ADDRESS)
            ).to.equal(amount - lockerFee);

            // Checks that enough coreBTC has been minted for locker
            expect(
                await coreBTC.balanceOf(signer1Address)
            ).to.equal(lockerFee);
        })


        it("can't mint core BTC above capacity", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await expect(
                lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 5001)
            ).to.be.revertedWith("Lockers: insufficient capacity")

        })

        it("allows only the minter to mint tokens", async function () {
            await expect(
                lockers.connect(signer1).mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 1000)
            ).to.be.revertedWith("Lockers: only minters can mint")
        })

        it("can't mint because receipt is zero address", async function () {
            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await expect(
                lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ZERO_ADDRESS, TX_ID, 25000000)
            ).to.be.revertedWith("Lockers: address is zero")
        })

        it("can't mint since locker is inactive", async function () {

            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockerSigner1.requestInactivation();

            expect(
                await lockers.isLockerActive(signer1Address)
            ).to.equal(true)

            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY + 10);


            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);

            await expect(
                lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 25000000)
            ).to.be.revertedWith("Lockers: not active")
        })


    });

    describe("#burn", async () => {

        let amount;

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Burns core BTC", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address)

            await lockers.addMinter(signer2Address)
            await lockers.addBurner(signer2Address)

            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 1000)

            let theLockerMapping = await lockers.lockersMapping(signer1Address);

            expect(
                theLockerMapping.netMinted
            ).to.equal(1000);

            await coreBTC.mint(signer2Address, 10000000)

            let coreBTCSigner2 = coreBTC.connect(signer2)

            amount = 900;
            let lockerFee = Math.floor(amount * LOCKER_PERCENTAGE_FEE / 10000);

            await coreBTCSigner2.approve(lockers.address, amount);

            await lockerSigner2.burn(LOCKER1_PUBKEY__HASH, amount);

            theLockerMapping = await lockers.lockersMapping(signer1Address);

            expect(
                theLockerMapping.netMinted
            ).to.equal(1000 - amount + lockerFee);


        })
        it("Burns core BTC (CustomToken collateral)", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);

            await lockers.addLocker(signer1Address)
            await lockers.addMinter(signer2Address)
            await lockers.addBurner(signer2Address)

            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 1000)

            await coreBTC.mint(signer2Address, 10000000);

            let coreBTCSigner2 = coreBTC.connect(signer2)
            amount = 900;
            let lockerFee = Math.floor(amount * LOCKER_PERCENTAGE_FEE / 10000);

            await coreBTCSigner2.approve(lockers.address, amount);

            await lockerSigner2.burn(LOCKER1_PUBKEY__HASH, amount);

            let theLockerMapping = await lockers.lockersMapping(signer1Address);

            expect(
                theLockerMapping.netMinted
            ).to.equal(1000 - amount + lockerFee);


        })
        it("Burns core BTC with 100% lockerFee rate", async function () {

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);

            await lockers.addLocker(signer1Address)
            await lockers.addMinter(signer2Address)
            await lockers.addBurner(signer2Address)

            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 1000)

            await coreBTC.mint(signer2Address, 10000000);

            let coreBTCSigner2 = coreBTC.connect(signer2)
            let new_locker_percentage_fee = 10000
            await lockers.setLockerPercentageFee(new_locker_percentage_fee)
            amount = 1000;
            await coreBTCSigner2.approve(lockers.address, amount);
            await expect(lockerSigner2.burn(LOCKER1_PUBKEY__HASH, amount)).to.emit(coreBTC, 'Burn').withArgs(
                lockers.address,
                lockers.address,
                0
            )
        })

        it("allows only the minter to mint tokens", async function () {
            await expect(lockers.burn(LOCKER1_PUBKEY__HASH, 1000)).to.be.revertedWith('Lockers: only burners can burn');
        })


    });

    describe("#liquidateLocker", async () => {

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("liquidate locker reverts when the target address is not locker", async function () {
            let lockerCCBurnSimulator = lockers.connect(ccBurnSimulator)

            await expect(
                lockerCCBurnSimulator.liquidateLocker(
                    signer1Address,
                    1000
                )
            ).to.be.revertedWith("Lockers: input address is not a valid locker")
        })

        it("can't liquidate because it's above liquidation ratio", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 5000000);

            await expect(
                lockerSigner2.liquidateLocker(signer1Address, 5000)
            ).to.be.revertedWith("Lockers: is healthy")

        });

        it("can't liquidate because it's above the liquidated amount", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 25000000);

            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);

            await expect(
                lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(3)
                )
            ).to.be.revertedWith("Lockers: not enough collateral to buy")

        });
        it("can't liquidate because it's above the liquidated amount (custom token as collateral)", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, ONE_ADDRESS, TX_ID, 25000000);

            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);

            await expect(
                lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(3)
                )
            ).to.be.revertedWith("Lockers: not enough collateral to buy")

        });

        it("successfully liquidate the locker", async function () {

            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 25000000);


            let coreBTCSigner2 = await coreBTC.connect(signer2);

            await coreBTCSigner2.approve(lockers.address, 13300000 + 1) // add 1 bcz of precision loss

            let signer2NativeTokenBalanceBefore = await coreBTC.provider.getBalance(signer2Address)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);

            await expect(
                lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.emit(lockerSigner2, "LockerLiquidated")


            let signer2NativeTokenBalanceAfter = await coreBTC.provider.getBalance(signer2Address)

            expect(
                signer2NativeTokenBalanceAfter.sub(signer2NativeTokenBalanceBefore)
            ).to.be.closeTo(BigNumber.from(10).pow(18).mul(2), BigNumber.from(10).pow(15).mul(1))


        });
        it("reverts when liquidate amount to burn is zero", async function () {

            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(0);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 25000000);
            let coreBTCSigner2 = await coreBTC.connect(signer2);
            await coreBTCSigner2.approve(lockers.address, 13300000 + 1) // add 1 bcz of precision loss
            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);
            await expect(
                lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.be.revertedWith('Lockers: burnt amount is zero')


        });
        it("successfully liquidate the locker (custom token as collateral)", async function () {

            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);

            await lockers.addLocker(signer1Address);

            await lockers.addMinter(signer2Address);

            let lockerSigner2 = lockers.connect(signer2)

            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 25000000);

            let coreBTCSigner2 = coreBTC.connect(signer2);

            await coreBTCSigner2.approve(lockers.address, 13300000 + 1) // add 1 bcz of precision loss
            await mockPriceOracle.mock.equivalentOutputAmount.returns(7000000);
            await expect(
                await lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.emit(lockerSigner2, "LockerLiquidated")

            let signerErc20Balance = await erc20.balanceOf(signer2Address);
            expect(signerErc20Balance).equal(BigNumber.from(10).pow(18).mul(2))
        });
        it("prevents collateralAmount from being zero", async function () {

            await expect(
                lockers.liquidateLocker(
                    signer1Address,
                    0
                )
            ).to.be.revertedWith('Lockers: value is zero')
        });
        it("calculates health factor with zero netMinted", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await lockers.addLocker(signer1Address);
            await expect(
                lockers.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.be.revertedWith('Lockers: netMinted or liquidationRatio is zero')
        });
        it("calculates health factor correctly when netMinted is zero", async function () {
            await lockers.setCCBurnRouter(mockCCBurnRouter.address);
            await mockCCBurnRouter.mock.ccBurn.returns(8000);
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000);
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);
            await lockers.addLocker(signer1Address);
            await lockers.addMinter(signer2Address);
            let lockerSigner2 = lockers.connect(signer2)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(50000000);
            await lockerSigner2.mint(LOCKER1_PUBKEY__HASH, signer2Address, TX_ID, 25000000);
            await lockers.setLiquidationRatio(0)
            await expect(
                lockerSigner2.liquidateLocker(
                    signer1Address,
                    BigNumber.from(10).pow(18).mul(2)
                )
            ).to.be.revertedWith("Lockers: netMinted or liquidationRatio is zero")
        });

    });

    describe("#addCollateral", async () => {

        it("can't add collateral for a non locker account", async function () {
            await expect(
                lockers.addCollateral(
                    signer2Address,
                    10000,
                    {value: 10000}
                )
            ).to.be.revertedWith("Lockers: no locker");
        })


        it("reverts because of insufficient msg value", async function () {
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            let lockerSigner2 = lockers.connect(signer2)

            await expect(
                lockerSigner2.addCollateral(
                    signer1Address,
                    10001,
                    {value: 10000}
                )
            ).to.be.revertedWith("Lockers: msg value")

        })

        it("adding collateral to the locker", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            let theLockerBefore = await lockers.lockersMapping(signer1Address)

            await expect(
                lockerSigner1.addCollateral(
                    signer1Address,
                    10000,
                    {value: 10000}
                )
            ).to.emit(lockerSigner1, "CollateralAdded")


            let theLockerAfter = await lockers.lockersMapping(signer1Address)
            expect(
                theLockerAfter.lockedAmount.sub(theLockerBefore.lockedAmount)
            ).to.equal(10000)

        })

        it("adding customToken collateral to the locker", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);

            let theLockerBefore = await lockers.lockersMapping(signer1Address)
            let addCollateralNumber = 10000
            await erc20.connect(deployer).transfer(signer1Address, addCollateralNumber)
            await erc20.connect(signer1).approve(lockers.address, addCollateralNumber);
            await expect(
                lockerSigner1.addCollateral(
                    signer1Address,
                    addCollateralNumber,
                    {value: addCollateralNumber}
                )
            ).to.emit(lockerSigner1, "CollateralAdded")

            let theLockerAfter = await lockers.lockersMapping(signer1Address)
            expect(
                theLockerAfter.lockedAmount.sub(theLockerBefore.lockedAmount)
            ).to.equal(addCollateralNumber)

        })
        it("Reverts when adding CustomToken collateral with insufficient approval amount", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);

            let addCollateralNumber = 10000
            await erc20.connect(deployer).transfer(signer1Address, addCollateralNumber)
            await erc20.connect(signer1).approve(lockers.address, addCollateralNumber - 1);
            await expect(
                lockerSigner1.addCollateral(
                    signer1Address,
                    addCollateralNumber,
                    {value: addCollateralNumber}
                )
            ).to.revertedWith("ERC20: insufficient allowance")

        })


        it("Reverts when adding collateral with insufficient assets", async function () {

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);

            let addCollateralNumber = 10000
            await erc20.connect(deployer).transfer(signer1Address, addCollateralNumber - 1)
            await erc20.connect(signer1).approve(lockers.address, addCollateralNumber);
            await expect(
                lockerSigner1.addCollateral(
                    signer1Address,
                    addCollateralNumber,
                    {value: addCollateralNumber}
                )
            ).to.revertedWith("ERC20: transfer amount exceeds balance")

        })


    });

    describe("#priceOfOneUnitOfCollateralInBTC", async () => {
        it("return what price oracle returned", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = await lockers.connect(signer1)

            expect(
                await lockerSigner1.priceOfOneUnitOfCollateralInBTC(NATIVE_TOKEN)
            ).to.equal(10000)
            await mockPriceOracle.mock.equivalentOutputAmount.returns(1000)
            expect(
                await lockerSigner1.priceOfOneUnitOfCollateralInBTC(erc20Address)
            ).to.equal(1000)
        })
    })


    describe("#removeCollateral", async () => {

        it("can't remove collateral for a non locker account", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = await lockers.connect(signer1)

            await expect(
                lockerSigner1.removeCollateral(
                    1000
                )
            ).to.be.revertedWith("Lockers: no locker")
        })

        it("prevents deletion when locker is active", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            // Forwards block.timestamp to inactivate locker
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);

            await expect(
                lockerSigner1.removeCollateral(
                    (minRequiredNativeTokenLockedAmount.div(2)).add(1)
                )
            ).to.be.revertedWith("Lockers: still active")

        })


        it("reverts because it's more than capacity", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            // inactivate the locker
            await lockerSigner1.requestInactivation();

            // Forwards block.timestamp to inactivate locker
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);

            await expect(
                lockerSigner1.removeCollateral(
                    (minRequiredNativeTokenLockedAmount.div(2)).add(1)
                )
            ).to.be.revertedWith("Lockers: more than max removable collateral")

        })

        it("reverts because it becomes below the min required collateral", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = lockers.connect(signer1)

            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            // inactivate the locker
            await lockerSigner1.requestInactivation();

            // Forwards block.timestamp to inactivate locker
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);

            await expect(
                lockerSigner1.removeCollateral(minRequiredNativeTokenLockedAmount.div(2))
            ).to.be.revertedWith("Lockers: less than min collateral")
        })

        it("remove collateral successfully", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount.mul(2), NATIVE_TOKEN);

            await lockers.addLocker(signer1Address);

            let theLockerBalanceBefore = await signer1.getBalance();
            let lockerBalanceBefore = await lockers.provider.getBalance(lockers.address);
            // inactivate the locker
            await lockerSigner1.requestInactivation();

            // Forwards block.timestamp to inactivate locker
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);

            await expect(
                await lockerSigner1.removeCollateral(
                    minRequiredNativeTokenLockedAmount.div(2)
                )
            ).to.emit(lockerSigner1, "CollateralRemoved")


            let theLockerBalanceAfter = await signer1.getBalance();
            let lockerBalanceAfter = await lockers.provider.getBalance(lockers.address);
            expect(
                theLockerBalanceAfter.sub(theLockerBalanceBefore)
            ).to.be.closeTo(minRequiredNativeTokenLockedAmount.div(2), BigNumber.from(10).pow(15).mul(1))
            expect(lockerBalanceBefore.sub(lockerBalanceAfter)).equal(minRequiredNativeTokenLockedAmount.div(2));

        })


        it("remove collateral successfully (custom token as collateral)", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)

            let lockerSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount.mul(2), erc20Address);

            await lockers.addLocker(signer1Address);

            // inactivate the locker
            await lockerSigner1.requestInactivation();

            // Forwards block.timestamp to inactivate locker
            let theLockerBalanceBefore = await erc20.balanceOf(lockers.address)
            let lastBlockTimestamp = await getTimestamp();
            await advanceBlockWithTime(deployer.provider, lastBlockTimestamp + INACTIVATION_DELAY);
            await expect(
                await lockerSigner1.removeCollateral(
                    minRequiredNativeTokenLockedAmount.div(2)
                )
            ).to.emit(lockerSigner1, "CollateralRemoved")
            let singer1Balance = await erc20.balanceOf(signer1Address);
            expect(singer1Balance).to.equal(minRequiredNativeTokenLockedAmount.div(2));
            let LockerBalanceAfter = await erc20.balanceOf(lockers.address)
            expect(theLockerBalanceBefore.sub(LockerBalanceAfter)).equal(minRequiredNativeTokenLockedAmount.div(2));

        })
    });


    describe("#isCollateralUnused", async () => {
        it("collateral not utilized", async function () {
            let isCollateralUnused = await lockers.isCollateralUnused(NATIVE_TOKEN)
            expect(isCollateralUnused).to.equal(true);
        })
        it("Lockers utilize Collateral", async function () {
            let lockersSigner1 = lockers.connect(signer1)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            let isCollateralUnused0 = await lockers.isCollateralUnused(erc20Address)
            expect(isCollateralUnused0).to.equal(false);
            await lockers.addLocker(signer1Address);
            let isCollateralUnused1 = await lockers.isCollateralUnused(erc20Address)
            expect(isCollateralUnused1).to.equal(false);
            await lockersSigner1.requestInactivation()
            await advanceBlockWithTime(deployer.provider, INACTIVATION_DELAY);
            await lockersSigner1.selfRemoveLocker()
            let isCollateralUnused2 = await lockers.isCollateralUnused(erc20Address)
            expect(isCollateralUnused2).to.equal(true);
            let isCollateralUnused = await lockers.isCollateralUnused(NATIVE_TOKEN)
            expect(isCollateralUnused).to.equal(true);

        })
    })

    describe("#initForMultipleCollateralsFeature", async () => {
        it("Reverts when trying to reinitialize", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await expect(
                lockers.initForMultipleCollateralsFeature([signer1Address])
            ).to.revertedWith('Lockers: candidate lockers is already inited')
        })

        it("Reverts when non-owner calls the function", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await expect(
                lockers.connect(signer1).initForMultipleCollateralsFeature([signer1Address])
            ).to.be.revertedWith('Ownable: caller is not the owner')

        })
        it("Reverts when target address list is invalid", async function () {
            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await lockers.addLocker(signer1Address);
            await expect(
                lockers.initForMultipleCollateralsFeature([signer1Address])
            ).to.be.revertedWith('Lockers: target address list is invalid')

        })
        it("Reverts when initialCandidates contains duplicate data", async function () {

            await mockPriceOracle.mock.equivalentOutputAmount.returns(10000)
            await becomeLockerCandidate(signer1, minRequiredNativeTokenLockedAmount, erc20Address);
            await becomeLockerCandidate(signer2, minRequiredNativeTokenLockedAmount, erc20Address);
            await expect(
                lockers.initForMultipleCollateralsFeature([signer1Address, signer1Address])
            ).to.be.revertedWith('Lockers: candidate lockers is already inited')

        })

    })
})
