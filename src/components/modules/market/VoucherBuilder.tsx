"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Clock, Zap, Award, DollarSign } from "lucide-react";

export default function VoucherBuilder() {
  const [hours, setHours] = useState(1);
  const [minutes, setMinutes] = useState(0);
  const [skill, setSkill] = useState(5);
  const [difficulty, setDifficulty] = useState(5);
  const [resourceCost, setResourceCost] = useState("");

  const totalHours = hours + minutes / 60;
  const calculatedThanks = Math.round(Math.sqrt(skill * difficulty) * totalHours);

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-center">
          <div className="text-sm text-muted-foreground mb-2">Estimated Voucher Value</div>
          <div className="text-4xl font-bold text-primary">{calculatedThanks} Thanks</div>
          {resourceCost && (
            <div className="text-lg text-muted-foreground mt-1">${parseFloat(resourceCost).toFixed(2)} Resource Cost</div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label className="flex items-center gap-2"><Clock className="h-4 w-4" />Time Required</Label>
          <div className="flex gap-4">
            <div className="flex-1">
              <Label className="text-xs text-muted-foreground">Hours</Label>
              <Input type="number" min={0} max={999} value={hours} onChange={(e) => setHours(Math.max(0, parseInt(e.target.value) || 0))} />
            </div>
            <div className="flex-1">
              <Label className="text-xs text-muted-foreground">Minutes</Label>
              <select className="w-full p-2 border rounded-md bg-background text-foreground" value={minutes} onChange={(e) => setMinutes(parseInt(e.target.value))}>
                <option value={0}>0</option>
                <option value={15}>15</option>
                <option value={30}>30</option>
                <option value={45}>45</option>
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <Label className="flex items-center gap-2"><Zap className="h-4 w-4" />Skill Level</Label>
            <span className="text-sm text-muted-foreground">{skill}/100</span>
          </div>
          <Slider value={[skill]} onValueChange={(v) => setSkill(v[0])} min={1} max={100} step={1} />
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <Label className="flex items-center gap-2"><Award className="h-4 w-4" />Difficulty</Label>
            <span className="text-sm text-muted-foreground">{difficulty}/100</span>
          </div>
          <Slider value={[difficulty]} onValueChange={(v) => setDifficulty(v[0])} min={1} max={100} step={1} />
        </div>

        <div className="space-y-3">
          <Label className="flex items-center gap-2"><DollarSign className="h-4 w-4" />Resource Cost ($)</Label>
          <Input type="number" min={0} step="0.01" placeholder="0.00" value={resourceCost} onChange={(e) => setResourceCost(e.target.value)} />
        </div>
      </CardContent>
    </Card>
  );
}
