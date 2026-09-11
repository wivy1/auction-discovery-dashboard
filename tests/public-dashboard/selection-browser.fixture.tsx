import { createRoot } from "react-dom/client";
import { AuctionDashboard } from "../../app/components/auction-dashboard";
import "../../app/globals.css";

createRoot(document.getElementById("root")!).render(<AuctionDashboard appName="Selection browser fixture" originPostalCode="90210" />);
