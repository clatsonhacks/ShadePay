// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract StreamSettleVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 5141173850987760717263358351443372251542330505275765966189922320550726366508;
    uint256 constant alphay  = 10205452431040597704376143033029034885577447791054380814279242597598211664018;
    uint256 constant betax1  = 13542136288405189413771353477767233123303619879904347473523483593992957341352;
    uint256 constant betax2  = 3336273949599465742578717466444936757885753961312442313382625203019174922408;
    uint256 constant betay1  = 16832926990077782578542790707771976975154561213505298965831500803767864781849;
    uint256 constant betay2  = 16094957125214348601679085324326641899422382584833355885406073096264881440752;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 12599857379517512478445603412764121041984228075771497593287716170335433683702;
    uint256 constant deltax2 = 7912208710313447447762395792098481825752520616755888860068004689933335666613;
    uint256 constant deltay1 = 11502426145685875357967720478366491326865907869902181704031346886834786027007;
    uint256 constant deltay2 = 21679208693936337484429571887537508926366191105267550375038502782696042114705;

    
    uint256 constant IC0x = 6705840272879813176644817545537926031927145848286834533455856245673365278830;
    uint256 constant IC0y = 7232039230311944318492338269990619713552718792731721113173749227350493285875;
    
    uint256 constant IC1x = 18261428105465217431484232051115311572098433611255534158873599859183578258018;
    uint256 constant IC1y = 7311202274151051305297601684970041946272779108086126539799024740845527673799;
    
    uint256 constant IC2x = 9383904330484000137186579589382394270578622675302824760024971290612350201818;
    uint256 constant IC2y = 5001144069924854278629581295225652110014873858730782915737683432514118288788;
    
    uint256 constant IC3x = 16740308079256584459070589773588090126154686561328249041537586153682181257789;
    uint256 constant IC3y = 14114709092940179831991816298531813931774752941176135992559781106764310555854;
    
    uint256 constant IC4x = 5371174798363331948998490869172233073719208438355175637232945143021210581127;
    uint256 constant IC4y = 15375868356759972091266691746944299469393543004493209840239022690342538271282;
    
    uint256 constant IC5x = 1017648051149426504869941473169083789849227887065228840225939495538509724477;
    uint256 constant IC5y = 2656753003512853877805581994548613288476342911990906375705608677229307131109;
    
    uint256 constant IC6x = 12085804110185506811234572176417001771818103256968828026761726555328680228561;
    uint256 constant IC6y = 15703758490612417416628030166258117376768191224693585142409967212239673602757;
    
    uint256 constant IC7x = 17820932189685200493636883184237705633787988266398286940862551903041509865269;
    uint256 constant IC7y = 15081623762649933583061357450654750166463974497994008774755303826701444823665;
    
    uint256 constant IC8x = 9011852748921212738647548965790770080272366722247319766931724166629483035845;
    uint256 constant IC8y = 14013417686007413705620363335096069955601779484662611069668253260149633798139;
    
    uint256 constant IC9x = 16059913948274055074905293768898128705649870730517608918912976549439474290991;
    uint256 constant IC9y = 17837805886113718482565177366592073196583733365245417693800738886695407093156;
    
    uint256 constant IC10x = 15763684754748461351030133201188728627030285667525856631887793633643397606013;
    uint256 constant IC10y = 3193688867089186900857202809991892974904069729719075206580856221269032303285;
    
    uint256 constant IC11x = 9620099520870213753913214052201485051667115666319188588699090751665854317409;
    uint256 constant IC11y = 10119560966946298747337843111948407936399799966547250998891858809488177373848;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[11] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
