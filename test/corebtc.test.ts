import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber} from "ethers";
import {Address} from "hardhat-deploy/types";
import {CoreBTCLogic} from "../src/types/CoreBTCLogic";
import {CoreBTCLogic__factory} from "../src/types/factories/CoreBTCLogic__factory";
import {CoreBTCProxy__factory} from "../src/types/factories/CoreBTCProxy__factory";
import {network} from "hardhat"


describe("CoreBTC", async () => {

    // Constants
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    const OTHER_ADDRESS = "0x0000000000000000000000000000000000000012";
    const maxMintLimit = 10 ** 8;
    const epochLength = 2000;

    // Accounts
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let deployerAddress: Address;
    let signer1Address: Address;
    let signer2Address: Address;

    // Contracts
    let coreBTCLogic: CoreBTCLogic;

    before(async () => {
        // Sets accounts
        [deployer, signer1, signer2] = await ethers.getSigners();
        deployerAddress = await deployer.getAddress();
        signer1Address = await signer1.getAddress();
        signer2Address = await signer2.getAddress();

        // Deploys logic contract
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


        // Deploys proxy contract
        const coreBTCProxyFactory = new CoreBTCProxy__factory(deployer);
        const coreBTCProxy = await coreBTCProxyFactory.deploy(
            coreBTCLogicImpl.address,
            initCode
        );

        // Create contract instance（bind proxy address to abi of logic contract）
        coreBTCLogic = await coreBTCLogicFactory.attach(
            coreBTCProxy.address
        );

        // Initialize contract
        // await coreBTCLogic.initialize(
        //     "coreBTC",
        //     "CBTC"
        // );

        // add signer2Address as minter of coreBTC
        await coreBTCLogic.addMinter(signer2Address)
    });


    describe("#mint rate limit", async () => {

        it("can't mint more than maximum mint limit in one transaction", async function () {
            await expect(
                coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, maxMintLimit * 2)
            ).to.be.revertedWith(
                "CoreBTC: mint amount is more than maximum mint limit"
            )
        })

        it("can't mint more than maximum mint limit in one epoch", async function () {
            await coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, maxMintLimit - 10)
            await expect(
                await coreBTCLogic.lastMintLimit()
            ).to.be.equal(
                10
            )
            await expect(
                coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, 11)
            ).to.be.revertedWith(
                "CoreBTC: reached maximum mint limit"
            )
        })

        it("after an epoch, mint rate limit will be reset", async function () {
            await moveBlocks(epochLength)

            await coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, maxMintLimit - 10)
            await expect(
                await coreBTCLogic.lastMintLimit()
            ).to.be.equal(
                10
            )

            await coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, 5)
            await expect(
                await coreBTCLogic.lastMintLimit()
            ).to.be.equal(
                5
            )

            await expect(
                coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, 10)
            ).to.be.revertedWith(
                "CoreBTC: reached maximum mint limit"
            )

            await moveBlocks(epochLength)
            await coreBTCLogic.connect(signer2).mint(ONE_ADDRESS, 10)
            await expect(
                await coreBTCLogic.lastMintLimit()
            ).to.be.equal(
                maxMintLimit - 10
            )
        })

        async function moveBlocks(amount: number) {
            for (let index = 0; index < amount; index++) {
                await network.provider.request({
                    method: "evm_mine",
                    params: [],
                })
            }
        }

    });

    describe("#burn and mint", async () => {

        it("non burner account can't burn tokens", async function () {
            await expect(
                coreBTCLogic.connect(signer2).burn(10)
            ).to.be.revertedWith(
                "CoreBTC: only burners can burn"
            )
        })
        it("non minter account can't mint tokens", async function () {
            await expect(
                coreBTCLogic.connect(deployer).mint(deployerAddress, 10)
            ).to.be.revertedWith(
                "CoreBTC: only minters can mint"
            )
        })
        it("can't mint or burn tokens when account is 0", async function () {
            await expect(
                coreBTCLogic.connect(ZERO_ADDRESS).mint(deployerAddress, 10)
            ).to.be.revertedWith(
                "CoreBTC: zero address"
            )
            await expect(
                coreBTCLogic.connect(ZERO_ADDRESS).burn(10)
            ).to.be.revertedWith(
                "CoreBTC: zero address"
            )
        })

        it("minters can mint tokens and burner can burn tokens", async function () {
            await coreBTCLogic.addBurner(signer2Address)
            await coreBTCLogic.connect(signer2).mint(signer2Address, 10)
            await expect(
                coreBTCLogic.connect(signer2).burn(10)
            ).to.emit(
                coreBTCLogic, "Burn"
            ).withArgs(signer2Address, signer2Address, 10);
        })

    });

    describe("#minter", async () => {

        it("add minter", async function () {
            await expect(
                await coreBTCLogic.addMinter(ONE_ADDRESS)
            ).to.emit(
                coreBTCLogic, "MinterAdded"
            ).withArgs(ONE_ADDRESS);
        })

        it("can't add zero address as minter", async function () {
            await expect(
                coreBTCLogic.addMinter(ZERO_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: zero address"
            )
        })

        it("can't add minter twice", async function () {
            await expect(
                coreBTCLogic.addMinter(ONE_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: already has role"
            )
        })

        it("can't remove not exist minter", async function () {
            await expect(
                coreBTCLogic.removeMinter(OTHER_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: does not have role"
            )
        })

        it("remove minter", async function () {
            await expect(
                await coreBTCLogic.removeMinter(ONE_ADDRESS)
            ).to.emit(
                coreBTCLogic, "MinterRemoved"
            ).withArgs(ONE_ADDRESS);
        })

    });

    describe("#burner", async () => {

        it("add burner", async function () {
            await expect(
                await coreBTCLogic.addBurner(ONE_ADDRESS)
            ).to.emit(
                coreBTCLogic, "BurnerAdded"
            ).withArgs(ONE_ADDRESS);
        })

        it("can't add zero address as burner", async function () {
            await expect(
                coreBTCLogic.addBurner(ZERO_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: zero address"
            )
        })

        it("can't add burner twice", async function () {
            await expect(
                coreBTCLogic.addBurner(ONE_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: already has role"
            )
        })

        it("can't remove not exist burner", async function () {
            await expect(
                coreBTCLogic.removeBurner(OTHER_ADDRESS)
            ).to.be.revertedWith(
                "CoreBTC: does not have role"
            )
        })

        it("remove burner", async function () {
            await expect(
                await coreBTCLogic.removeBurner(ONE_ADDRESS)
            ).to.emit(
                coreBTCLogic, "BurnerRemoved"
            ).withArgs(ONE_ADDRESS);
        })
    });

    describe("Renounce ownership", async () => {
        it("owner can't renounce his ownership", async function () {
            await coreBTCLogic.renounceOwnership()
            await expect(
                await coreBTCLogic.owner()
            ).to.be.equal(deployerAddress)
        })
    })

    describe("Setters", async () => {

        it("none owner accounts can't change maximum mint limit", async function () {
            await expect(
                coreBTCLogic.connect(signer1).setMaxMintLimit(10)
            ).to.be.revertedWith(
                "Ownable: caller is not the owner"
            )
        })

        it("owner account can change maximum mint limit", async function () {
            await expect(
                await coreBTCLogic.setMaxMintLimit(10)
            ).to.emit(
                coreBTCLogic, "NewMintLimit"
            ).withArgs(
                maxMintLimit, 10
            )

            await expect(
                await coreBTCLogic.maxMintLimit()
            ).to.equal(10)

        })

        it("none owner accounts can't change epoch length", async function () {
            await expect(
                coreBTCLogic.connect(signer1).setEpochLength(10)
            ).to.be.revertedWith(
                "Ownable: caller is not the owner"
            )
        })

        it("can't change epoch length to zero", async function () {
            await expect(
                coreBTCLogic.connect(deployer).setEpochLength(0)
            ).to.be.revertedWith(
                "CoreBTC: value is zero"
            )
        })

        it("owner account can change epoch length", async function () {
            await expect(
                await coreBTCLogic.setEpochLength(10)
            ).to.emit(
                coreBTCLogic, "NewEpochLength"
            ).withArgs(
                epochLength, 10
            )

            await expect(
                await coreBTCLogic.epochLength()
            ).to.equal(10)

        })
    })
    describe("Blacklist", async () => {
        it("addBlackLister", async function () {
            await expect(
                coreBTCLogic.addBlackLister(signer2Address)
            ).to.emit(coreBTCLogic, 'BlackListerAdded')
        })
        it("should prevent duplicate entries in the blacklist", async function () {
            await expect(
                coreBTCLogic.addBlackLister(signer2Address)
            ).to.be.revertedWith('CoreBTC: already has role')
        })
        it("removeBlackLister", async function () {
            await expect(
                coreBTCLogic.removeBlackLister(signer2Address)
            ).to.emit(coreBTCLogic, 'BlackListerRemoved')
        })

        it("should not allow removal of non-blacklisted account", async function () {
            await expect(
                coreBTCLogic.removeBlackLister(signer2Address)
            ).to.be.revertedWith('CoreBTC: does not have role')
        })
        it("should not allow mint or burn tokens for accounts in the blacklist", async function () {
            await coreBTCLogic.addBlackLister(signer1Address)
            await coreBTCLogic.addMinter(signer1Address)
            await coreBTCLogic.addBurner(signer1Address)
            await expect(coreBTCLogic.connect(signer1).blacklist(signer1Address)
            ).to.emit(coreBTCLogic, 'Blacklisted')
            await expect(
                coreBTCLogic.connect(signer1).mint(signer1Address, 8)
            ).to.be.revertedWith('CoreBTC: to is blacklisted')
            await expect(
                coreBTCLogic.connect(signer1).burn(8)
            ).to.be.revertedWith('CoreBTC: from is blacklisted')

        })
    })

    describe("Getters", async () => {
        it("decimal is correct", async function () {
            await expect(
                await coreBTCLogic.decimals()
            ).to.be.equal(8)
        })
    })
})