interface ISymmio {
    function depositFor(address user, uint256 amount) external;
    function withdrawTo(address user, uint256 amount) external;
    function allocate(uint256 amount) external;
    function getCollateral() external view returns (address);
    function balanceOf(address user) external view returns (uint256);
    function setSigner(address signer) external;
}