import {revertProvider, takeSnapshot} from "./block_utils";

require('dotenv').config({path: "../../.env"});
import Web3 from 'web3';
import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber, utils} from "ethers";
import {deployMockContract, MockContract} from "@ethereum-waffle/mock-contract";
import {Contract} from "@ethersproject/contracts";
import {Address} from "hardhat-deploy/types";

import {CollateralsLogic__factory} from "../src/types/factories/CollateralsLogic__factory";
import {CollateralsProxy__factory} from "../src/types/factories/CollateralsProxy__factory";
import {CollateralsLogic, IERC20} from "../src/types";
import {Erc20} from "../src/types/ERC20";
import {Erc20__factory} from "../src/types/factories/Erc20__factory";

describe("collaterals ", async () => {

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let NATIVE_TOKEN = "0x0000000000000000000000000000000000000001";
    let TWO_ADDRESS = "0x0000000000000000000000000000000000000002";
    let NEW_TOKEN = "0x0000000000000000000000000000000000000003";
    let FOUR_TOKEN = "0x0000000000000000000000000000000000000004";
    let minRequiredTNTLockedAmount = BigNumber.from(10).pow(18).mul(5);


    // Accounts
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let deployerAddress: Address;
    let lockerTargetAddress: Address;
    // Contracts
    let collaterals: CollateralsLogic;
    let collaterals2: CollateralsLogic;
    let erc20: Erc20;
    let _erc20: Erc20;

    // Mock contracts
    let mockLockers: MockContract;
    let snapshotId: any;
    let beginning: any;

    before(async () => {
        [deployer, signer1, signer2] = await ethers.getSigners();
        deployerAddress = await deployer.getAddress();
        lockerTargetAddress = await signer2.getAddress();
        collaterals = await deployCollateral()
        collaterals2 = await deployCollateral();
        const lockers = await deployments.getArtifact(
            "LockersLogic"
        );
        mockLockers = await deployMockContract(
            deployer,
            lockers.abi
        )
        collaterals.initialize(mockLockers.address, minRequiredTNTLockedAmount)
        // Deploys erc20 contracts
        const erc20Factory = new Erc20__factory(deployer);
        erc20 = await erc20Factory.deploy(
            "TestToken",
            "TT",
            1000
        );
        _erc20 = await erc20Factory.deploy(
            "NewToken",
            "NT",
            1000
        );


    });

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

    async function setIsCollateralUnusedReturn(isTrue: boolean): Promise<void> {
        await mockLockers.mock.isCollateralUnused.returns(isTrue); // Sets result of isCollateralUnused
    }

    async function addCollateral(token: string, lockedAmount: BigNumber): Promise<void> {
        await collaterals.addCollateral(token, lockedAmount);
    }

    async function removeCollateral(token: string): Promise<void> {
        await collaterals.removeCollateral(token);
    }

    function encodeErrorMessage(functionSignature: string, args: any[]) {
        const web3 = new Web3();
        const selector = web3.utils.keccak256(functionSignature).slice(0, 10);
        const argsInFunctionSignature = functionSignature.slice(
            functionSignature.indexOf('(') + 1,
            functionSignature.indexOf(')')
        ).replace(/\s/g, '').split(',');
        const encodedArgs = web3.eth.abi.encodeParameters(argsInFunctionSignature, args);
        return selector + encodedArgs.slice(2);
    }
    
    describe("#initialize", async () => {
        it("initialize can be called only once", async function () {
            await expect(collaterals.initialize(mockLockers.address, minRequiredTNTLockedAmount)
            ).to.be.revertedWith("Initializable: contract is already initialized")
        })
        it("Reverts when initializing with zero address", async function () {
            await expect(collaterals2.initialize(ZERO_ADDRESS, minRequiredTNTLockedAmount)
            ).to.be.revertedWith("Lockers: address is zero")
        })
        it("Reverts when initializing with zero locked amount", async function () {
            await expect(collaterals2.initialize(mockLockers.address, 0)
            ).to.be.revertedWith("Lockers: amount is zero")
        })

    })
    describe("#checkLockedAmount", async () => {
        it("Reverts when locked amount is less than minimum collateral requirement", async function () {
            let minLockedAmount = await collaterals.getMinLockedAmount(NATIVE_TOKEN)
            expect(minLockedAmount).to.equal(minRequiredTNTLockedAmount)
            const encodedCall = encodeErrorMessage('InsufficientCollateral(address,uint256,uint256)',
                [NATIVE_TOKEN, minRequiredTNTLockedAmount.sub(1), minLockedAmount]);
            await expect(collaterals.checkLockedAmount(NATIVE_TOKEN, minRequiredTNTLockedAmount.sub(1))
            ).to.be.revertedWith(encodedCall)
        })
        it("Reverts when checking locked amount with zero token address", async function () {
            await expect(collaterals.checkLockedAmount(ZERO_ADDRESS, minRequiredTNTLockedAmount)
            ).to.be.revertedWith("Lockers: address is zero")
        })
        it("Reverts when checking collateral amount with non-existent token", async function () {
            await expect(collaterals.checkLockedAmount(TWO_ADDRESS, minRequiredTNTLockedAmount)
            ).to.be.revertedWith("Lockers: unsupported collateral")
        })
        it("Successfully checks collateral amount", async function () {
            await expect(collaterals.checkLockedAmount(NATIVE_TOKEN, minRequiredTNTLockedAmount)
            ).not.to.reverted;
        })


    })

    describe("#addCollateral", async () => {
        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });
        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });
        it("non owners can't call addCollateral", async function () {
            let collateralSigner1 = collaterals.connect(signer1)
            await expect(
                collateralSigner1.addCollateral(
                    NEW_TOKEN,
                    minRequiredTNTLockedAmount
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")

        })
        it("Reverts when adding existing token", async function () {
            await expect(
                collaterals.addCollateral(
                    NATIVE_TOKEN,
                    minRequiredTNTLockedAmount
                )
            ).to.be.revertedWith("Lockers: supported collateral")

        })
        it("Reverts when adding token with zero amount", async function () {
            await expect(
                collaterals.addCollateral(
                    NEW_TOKEN,
                    0
                )
            ).to.be.revertedWith("Lockers: amount is zero")

        })
        it("Reverts when adding token with zero address", async function () {
            await expect(
                collaterals.addCollateral(
                    ZERO_ADDRESS,
                    100000
                )
            ).to.be.revertedWith("Lockers: address is zero")

        })
        it("adds new collateral token successfully", async function () {
            let locked_amount = BigNumber.from(10).pow(18).mul(2);
            await expect(
                collaterals.addCollateral(
                    NEW_TOKEN,
                    locked_amount
                )
            ).to.emit(collaterals, 'NewSupportedCollateral').withArgs(
                NEW_TOKEN,
                locked_amount
            )
            let TotalNumber = await collaterals.getTotalNumber();
            let collaterals_length = await collaterals.collateralsMap(NEW_TOKEN);
            let [token, minLockedAmount] = await collaterals.getCollateral(collaterals_length.sub(1));
            expect(TotalNumber).to.equal(collaterals_length);
            expect(minLockedAmount).to.equal(locked_amount);
            expect(token).to.equal(NEW_TOKEN);
        })
        it("Successfully re-adds collateral after removal", async function () {
            setIsCollateralUnusedReturn(true)
            await addCollateral(TWO_ADDRESS, minRequiredTNTLockedAmount)
            await addCollateral(NEW_TOKEN, minRequiredTNTLockedAmount)
            await removeCollateral(TWO_ADDRESS)
            await addCollateral(TWO_ADDRESS, minRequiredTNTLockedAmount)
            let totalNumber = await collaterals.getTotalNumber();
            let collaterals_length = await collaterals.collateralsMap(TWO_ADDRESS);
            let [token] = await collaterals.getCollateral(collaterals_length.sub(1));
            expect(totalNumber).to.equal(collaterals_length);
            expect(token).to.equal(TWO_ADDRESS);
        })

    })
    describe("#removeCollateral", async () => {
        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });
        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });
        it("non owners can't call removeCollateral", async function () {
            let collateralSigner1 = collaterals.connect(signer1)
            await expect(
                collateralSigner1.removeCollateral(
                    NEW_TOKEN
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")

        })
        it("Reverts when removing non-existing collateral", async function () {
            await expect(
                collaterals.removeCollateral(
                    NEW_TOKEN
                )
            ).to.be.revertedWith("Lockers: unsupported collateral")

        })
        it("Reverts when trying to remove collateral in use", async function () {
            await setIsCollateralUnusedReturn(false)
            await expect(
                collaterals.removeCollateral(
                    NATIVE_TOKEN
                )
            ).to.be.revertedWith("Lockers: collateral in use")

        })
        it("Successfully removes native collateral", async function () {
            await setIsCollateralUnusedReturn(true)
            await expect(
                collaterals.removeCollateral(
                    NATIVE_TOKEN
                )
            ).to.be.emit(collaterals, "RevokeSupportedCollateral").withArgs(
                NATIVE_TOKEN
            )
            let TotalNumber = await collaterals.getTotalNumber();
            let collaterals_length = await collaterals.collateralsMap(NATIVE_TOKEN);
            expect(TotalNumber).to.equal(collaterals_length);
            expect(collaterals_length).to.equal(0);

        })
        it("Successfully removes collateral when multiple collaterals exist", async function () {
            await setIsCollateralUnusedReturn(true)
            await addCollateral(TWO_ADDRESS, minRequiredTNTLockedAmount.add(2))
            await addCollateral(NEW_TOKEN, minRequiredTNTLockedAmount.add(3))
            await addCollateral(FOUR_TOKEN, minRequiredTNTLockedAmount.add(4))
            await expect(
                collaterals.removeCollateral(
                    TWO_ADDRESS
                )
            ).to.be.emit(collaterals, "RevokeSupportedCollateral").withArgs(
                TWO_ADDRESS
            )
            let TotalNumber = await collaterals.getTotalNumber();
            expect(TotalNumber).to.equal(3);
            let nativeTokenIndex = await collaterals.collateralsMap(NATIVE_TOKEN);
            let fourTokenIndex = await collaterals.collateralsMap(FOUR_TOKEN);
            let newTokenIndex = await collaterals.collateralsMap(NEW_TOKEN);
            expect(nativeTokenIndex).to.equal(1);
            expect(fourTokenIndex).to.equal(2);
            expect(newTokenIndex).to.equal(3);
            let [token0] = await collaterals.getCollateral(0)
            let [token1] = await collaterals.getCollateral(1)
            let [token2] = await collaterals.getCollateral(2)
            expect(token0).to.equal(NATIVE_TOKEN);
            expect(token1).to.equal(FOUR_TOKEN);
            expect(token2).to.equal(NEW_TOKEN);
            await collaterals.removeCollateral(FOUR_TOKEN)
            let newTokenIndex1 = await collaterals.collateralsMap(NEW_TOKEN);
            expect(newTokenIndex1).to.equal(2);
            let [token] = await collaterals.getCollateral(newTokenIndex1.sub(1))
            expect(token).to.equal(NEW_TOKEN);
            let TotalNumber1 = await collaterals.getTotalNumber();
            expect(TotalNumber1).to.equal(2);


        })
        it("Reverts when collateral token address is zero in removeCollateral", async function () {
            await expect(
                collaterals.removeCollateral(
                    ZERO_ADDRESS
                )
            ).revertedWith('Lockers: address is zero')
        })


    })


    describe("#setLockers", async () => {
        it("non owners can't call setLockers", async function () {
            let collateralSigner1 = collaterals.connect(signer1)
            await expect(
                collateralSigner1.setLockers(
                    TWO_ADDRESS
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")

        })
        it("only owner can call setLockers", async function () {
            await expect(
                collaterals.setLockers(
                    TWO_ADDRESS
                )
            ).to.be.emit(collaterals, 'NewLockers').withArgs(
                mockLockers.address,
                TWO_ADDRESS
            )
            await collaterals.setLockers(mockLockers.address)
        })
        it("should Revert setLockers when address is zero", async function () {
            await expect(
                collaterals.setLockers(
                    ZERO_ADDRESS
                )
            ).revertedWith('Lockers: address is zero')
        })
    });

    describe("#setMinLockedAmount", async () => {
        it("non owners can't call setMinLockedAmount", async function () {
            let collateralSigner1 = collaterals.connect(signer1)
            await expect(
                collateralSigner1.setMinLockedAmount(
                    NATIVE_TOKEN,
                    1000000
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")

        })
        it("only owner can call setMinLockedAmount", async function () {
            let TNTLockerAmount = BigNumber.from(10).pow(18).mul(3);
            let [token, minLockedAmount] = await collaterals.getCollateral(0);
            expect(minLockedAmount).to.equal(minRequiredTNTLockedAmount);
            expect(token).to.equal(NATIVE_TOKEN);
            await expect(
                collaterals.setMinLockedAmount(
                    NATIVE_TOKEN,
                    TNTLockerAmount
                )
            ).to.be.emit(collaterals, 'NewMinRequiredLockedAmount').withArgs(
                NATIVE_TOKEN,
                minRequiredTNTLockedAmount,
                TNTLockerAmount
            )
            let [token1, minLockedAmount1] = await collaterals.getCollateral(0);
            expect(minLockedAmount1).to.equal(TNTLockerAmount);
            expect(token1).to.equal(NATIVE_TOKEN);
        })
        it("Reverts when token does not exist", async function () {
            await expect(
                collaterals.setMinLockedAmount(
                    TWO_ADDRESS,
                    1000000
                )
            ).to.be.revertedWith("Lockers: unsupported collateral")

        })
        it("Reverts when minLockedAmount is zero", async function () {
            await expect(
                collaterals.setMinLockedAmount(
                    NATIVE_TOKEN,
                    0
                )
            ).to.be.revertedWith("Lockers: amount is zero")

        })
        it("Successfully modifies minLockedAmount for multiple collaterals", async function () {
            setIsCollateralUnusedReturn(true)
            await addCollateral(TWO_ADDRESS, minRequiredTNTLockedAmount)
            await addCollateral(NEW_TOKEN, minRequiredTNTLockedAmount)
            await expect(
                collaterals.setMinLockedAmount(
                    TWO_ADDRESS,
                    10000
                )
            ).to.be.emit(collaterals, 'NewMinRequiredLockedAmount')
            let minLockerAmount = await collaterals.getMinLockedAmount(TWO_ADDRESS)
            expect(minLockerAmount).equal(10000)
            await collaterals.removeCollateral(TWO_ADDRESS)
            await collaterals.setMinLockedAmount(NEW_TOKEN, 20000)
            let minLockerAmount1 = await collaterals.getMinLockedAmount(NEW_TOKEN)
            expect(minLockerAmount1).equal(20000)

        })
    });


    describe("#renounce ownership", async () => {
        it("owner can't renounce ownership", async function () {
            await collaterals.renounceOwnership()
            await expect(
                await collaterals.owner()
            ).to.equal(deployerAddress);
        })
    });
})